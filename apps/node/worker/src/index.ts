import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { log, trimLogs, verifyChain } from "./audit.ts";
import { CallerError } from "./errors.ts";

import { claimNode } from "./claim.ts";
import { migrate } from "./migrate.ts";
import { applySendingEvent, claimedOrg, type SendingEvent } from "./outbound/events.ts";
import { EvidenceMissing, getEvidence, streamEvidence } from "./evidence-store.ts";
import { acceptInbound } from "./ingress.ts";
import { listMessages, authorize, principalFor } from "./authz-read.ts";
import { isAppRoute } from "./app-routes.ts";
import { deleteDraft, draftForReply, listDrafts, readDraft, saveDraft } from "./drafts.ts";
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
import { cancelSend, dailySendState, dispatchDue } from "./outbound/dispatch.ts";
import { sealManifest } from "./outbound/manifest.ts";
import { cloudflareTransport } from "./outbound/transport.ts";
import { formatReconcile, reconcileEvidence } from "./reconcile.ts";
import { resealBatch } from "./reseal.ts";
import { safeFilename } from "./outbound/headers.ts";
import { clientScript, page } from "./ui.ts";

export { OutboxSweeper } from "./outbox.ts";
export { KeyVault } from "./keyvault.ts";

/**
 * The Mailda Node. One Worker (ADR 18).
 *
 * Layer 1 of the ladder in AGENTS.md: receive one real internet message, store it
 * losslessly, and show it to one authorized human.
 */
export default {
  /**
   * Cloudflare Queues invokes this with `email.sending` events — the only channel by which a Node learns
   * what happened to a message after hand-over (receipt: `email-sending-events.md`).
   *
   * Each message is acked or retried **individually**. A batch-level failure would put one malformed
   * event in front of every good one behind it, and Queues retries the whole batch — so a single bad
   * message would block delivery outcomes indefinitely.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const clock = createSystemCtx();
    const orgId = await claimedOrg(env);

    for (const message of batch.messages) {
      if (orgId === null) {
        // An unclaimed Node has nowhere to file an outcome. Retried rather than acked: the events are
        // about real mail, and discarding them because setup is incomplete loses the only record.
        message.retry();
        continue;
      }
      try {
        await applySendingEvent(env, clock, orgId, message.body as SendingEvent);
        message.ack();
      } catch (error) {
        await log(env, clock, {
          level: "error",
          event: "sending_event.failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
          orgId,
          detail: { type: (message.body as SendingEvent)?.type ?? null },
        });
        message.retry();
      }
    }
  },

  /** Cloudflare Email Routing invokes this with a real message (§13). */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const clock = createSystemCtx();
    // `.catch` because an unmigrated Node has no `node_claim` table at all, and that is the state a
    // fresh install is in until migrations run. Throwing here fails the transport with an opaque error;
    // rejecting tells the sending server the message was not taken, which is the honest answer and the
    // one §13 requires. Unclaimed and unmigrated are both "nowhere to put it".
    const claimed = await env.CATALOG.prepare(
      "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
    ).first<{ org_id: string }>().catch(() => null);

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
    const clock = createSystemCtx();
    const requestId = clock.id("req");
    try {
      return noStore(new URL(request.url), await route(request, env, ctx));
    } catch (error) {
      // A caller error is not a fault: it has a remedy, and the caller is the one who can apply it.
      // The status travels with the throw (see errors.ts) rather than living in a table here that has
      // to be kept in agreement — the correspondence problem ADR 35 rejected for the effect key.
      // Lost mail is not a bug in the request path, and reporting it as one hides the only fact that
      // matters. The message carries §24's four-part shape — what, why, and the reconciler to run — and
      // until now the generic handler replaced all of it with "this Node failed to handle the request".
      // Still logged, because data loss must be visible to `doctor` and not only to whoever was looking
      // at the screen.
      if (error instanceof EvidenceMissing) {
        ctx.waitUntil(
          log(env, clock, {
            level: "error",
            event: "evidence.missing",
            message: error.message.split("\n")[0] ?? "evidence missing",
            requestId,
            detail: { blobKey: error.blobKey, path: new URL(request.url).pathname },
          }).then(() => trimLogs(env)).then(() => undefined),
        );
        return noStore(
          new URL(request.url),
          Response.json(
            { error: "evidence_missing", message: error.message, requestId },
            { status: 500 },
          ),
        );
      }

      if (error instanceof CallerError) {
        return noStore(
          new URL(request.url),
          Response.json({ error: error.code, message: error.message }, { status: error.status }),
        );
      }

      // Recorded where the Node itself can read it, not only in Cloudflare's dashboard — an operator
      // should not have to leave the product to find out why it misbehaved. `waitUntil` so a log write
      // never delays the response, and the request id is returned so a person can quote it.
      ctx.waitUntil(
        log(env, clock, {
          level: "error",
          event: "request.unhandled",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
          requestId,
          detail: { path: new URL(request.url).pathname, stack: (error as Error).stack?.slice(0, 1500) },
        }).then(() => trimLogs(env)).then(() => undefined),
      );
      console.error("E_UNHANDLED", requestId, (error as Error).stack ?? String(error));
      return Response.json(
        {
          error: "internal",
          message: "This Node failed to handle the request. Its operator can find this in the log.",
          requestId,
        },
        { status: 500 },
      );
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  {
    const url = new URL(request.url);
    const clock = createSystemCtx();

    /**
     * Applies any missing schema. Idempotent, and the only route that works on a Node with none.
     *
     * Unauthenticated on purpose, and the reasoning is the same one `/api/doctor` already uses: on a
     * freshly installed Node authentication is *impossible* — the tables it needs do not exist — so a
     * gate here would be one no caller could satisfy. What it can do is bounded to applying this
     * Node's own bundled migrations, which is idempotent and grants a caller nothing: an attacker who
     * migrates somebody's Node has done them a favour. Once the schema is current it is a no-op.
     */
    if (url.pathname === "/api/prepare" && request.method === "POST") {
      const outcome = await migrate(env);
      return Response.json({
        ...outcome,
        message: outcome.alreadyCurrent
          ? "The schema was already current. Nothing changed."
          : `Applied ${outcome.applied.length} migration(s). This Node can now accept mail once claimed.`,
      });
    }

    if (url.pathname === "/health") {
      // A health endpoint that throws when the Node is unhealthy is a health endpoint that reports
      // nothing. On a fresh install these tables do not exist yet, and 500 with an opaque body is the
      // least useful answer available — so the state is named, with the command that resolves it.
      const claimed = await env.CATALOG.prepare(
        "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
      ).first<{ org_id: string }>().catch(() => undefined);
      if (claimed === undefined) {
        return Response.json({
          node: "mailda",
          healthy: false,
          reason: "This Node has no schema, so it cannot accept mail.",
          fix: "POST /api/prepare to apply the schema, or run `wrangler d1 migrations apply CATALOG --remote`",
        }, { status: 503 });
      }
      const pending = await env.CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL",
      ).first<{ n: number }>().catch(() => null);
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
      const signedIn = (await principalFor(env, clock, request)) !== null;
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

    /**
     * Maintenance. Authenticated always — these read and delete an organization's evidence, so unlike
     * `doctor` there is no state in which an anonymous caller should reach them.
     *
     * Both are **bounded and resumable** rather than long-running: each call does one batch and
     * reports what remains, because a Worker invocation cannot re-seal ~8.5M messages and an
     * operation that pretends otherwise fails silently at scale (receipt: evidence-lifecycle.md).
     */
    if (url.pathname === "/api/maintenance/reseal" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const outcome = await resealBatch(env, clock, who.orgId);
      // 200 even with failures: the batch itself succeeded, and each failure is a named receipt the
      // caller has to act on rather than a request to retry.
      return Response.json(outcome);
    }

    if (url.pathname === "/api/maintenance/reconcile" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const collect = url.searchParams.get("collect") === "1";
      const report = await reconcileEvidence(env, clock, who.orgId, { collect });
      return url.searchParams.get("format") === "text"
        ? new Response(formatReconcile(report) + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
        : Response.json(report);
    }

    /**
     * Outbound (Layer 2). Sealing and dispatching are separate endpoints because they are separate
     * acts (ADR 35) — which is what makes undo-send honest rather than a claim about recall.
     */
    /**
     * Drafts. The composer autosaves here, so this is the one write path a person triggers by *typing*
     * rather than by deciding — which is why nothing about it is audited (see `0012_drafts.sql`) and why
     * the body goes to R2 encrypted rather than into a D1 column.
     */
    if (url.pathname === "/api/drafts" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // `?inReplyTo=` answers the composer's real question — "is there already a draft for this reply?" —
      // in one round trip. Without it the client would list every draft and filter, which is a decision
      // about somebody's unfinished work made in a browser.
      const inReplyTo = url.searchParams.get("inReplyTo");
      if (inReplyTo !== null) {
        return Response.json({ draft: await draftForReply(env, who.orgId, who.userId, inReplyTo) });
      }
      return Response.json({ drafts: await listDrafts(env, who.orgId, who.userId) });
    }

    if (url.pathname === "/api/drafts" && request.method === "PUT") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // PUT with an optional id rather than POST-then-PUT: the composer does not know whether this is the
      // first save, and making it decide is how a draft ends up saved twice under two ids.
      const draft = await saveDraft(
        env, clock, who.orgId, who.userId,
        body.id === undefined || body.id === null ? null : String(body.id),
        {
          mailboxId: String(body.mailboxId ?? ""),
          inReplyToMessageId:
            body.inReplyToMessageId === undefined || body.inReplyToMessageId === null
              ? null
              : String(body.inReplyToMessageId),
          to: Array.isArray(body.to) ? (body.to as string[]) : [],
          cc: Array.isArray(body.cc) ? (body.cc as string[]) : undefined,
          bcc: Array.isArray(body.bcc) ? (body.bcc as string[]) : undefined,
          subject: String(body.subject ?? ""),
          body: String(body.body ?? ""),
        },
      );
      return Response.json({ draft });
    }

    const draft = /^\/api\/drafts\/([^/]+)$/.exec(url.pathname);
    if (draft && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const record = await readDraft(env, who.orgId, who.userId, draft[1]!);
      // §5C: a draft that never existed and one belonging to somebody else answer identically.
      if (record === null) {
        return Response.json(
          { error: "not_found", message: "No such draft, or you do not have access to it." },
          { status: 404 },
        );
      }
      return Response.json({ draft: record });
    }

    if (draft && request.method === "DELETE") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const deleted = await deleteDraft(env, who.orgId, who.userId, draft[1]!);
      return Response.json({ deleted }, { status: deleted ? 200 : 404 });
    }

    if (url.pathname === "/api/sends" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();

      // §14: whether this Node can send is answerable *before* composing, not at submit.
      const capability = await cloudflareTransport.capability(env);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const sealed = await sealManifest(env, clock, who.orgId, {
        mailboxId: String(body.mailboxId ?? ""),
        authorUserId: who.userId,
        inReplyToMessageId: body.inReplyToMessageId === undefined ? undefined : String(body.inReplyToMessageId),
        to: Array.isArray(body.to) ? (body.to as string[]) : [],
        cc: Array.isArray(body.cc) ? (body.cc as string[]) : undefined,
        bcc: Array.isArray(body.bcc) ? (body.bcc as string[]) : undefined,
        subject: String(body.subject ?? ""),
        bodyTyped: String(body.body ?? ""),
        // ADR 33 requires this stated rather than inferred. Customer-facing mail is authored, because
        // its record must be able to prove exactly what was sent.
        fidelity: "authored",
      });

      // The draft is retired **after** the seal, and the order is the decision. Deleting first would lose
      // somebody's writing if sealing then failed; this way a failure between the two leaves a draft for a
      // message already sent, which is visible on the screen they are looking at and takes one click to
      // resolve. Not in the same transaction, because `sealManifest` owns its own batch — the residual is a
      // duplicate a person can see rather than a loss they cannot recover.
      if (typeof body.draftId === "string" && body.draftId !== "") {
        await deleteDraft(env, who.orgId, who.userId, body.draftId);
      }

      return Response.json({ ...sealed, capability });
    }

    /**
     * The exact bytes Mailda submitted, streamed frame by frame (#16).
     *
     * §12 invariant 2 makes a materialized provider-submission representation immutable evidence, and
     * storing it while providing no way to read it back is barely better than not storing it — the
     * point of the record is that an operator can *produce* it. Present only for the `authored` path,
     * because the structured API gives Mailda nothing to store (ADR 33).
     */
    const submitted = /^\/api\/sends\/([^/]+)\/submitted$/.exec(url.pathname);
    if (submitted && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const row = await env.CATALOG.prepare(
        "SELECT submitted_key, fidelity FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
      ).bind(who.orgId, submitted[1]!).first<{ submitted_key: string | null; fidelity: string }>();

      // §5C: an absent send and one belonging to another organization answer identically.
      if (row === null) {
        return Response.json(
          { error: "not_found", message: "No such send, or you do not have access to it." },
          { status: 404 },
        );
      }
      if (row.submitted_key == null) {
        return Response.json(
          {
            error: "no_submitted_bytes",
            message:
              row.fidelity === "reconstructed"
                ? "This message was sent through the structured API, which assembles the MIME itself — " +
                  "so there are no submitted bytes to produce. Its manifest records what was asked for."
                : "This message has not been dispatched yet, so nothing has been submitted.",
          },
          { status: 409 },
        );
      }
      return new Response(await streamEvidence(env, row.submitted_key), {
        headers: {
          "content-type": "message/rfc822",
          "content-disposition": `attachment; filename="${safeFilename(submitted[1]!, "-submitted.eml")}"`,
        },
      });
    }

    const cancel = /^\/api\/sends\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const outcome = await cancelSend(env, clock, who.orgId, cancel[1]!);
      return Response.json(outcome, { status: outcome.cancelled ? 200 : 409 });
    }

    if (url.pathname === "/api/sends" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const rows = await env.CATALOG.prepare(
        // `has_submitted` rather than the key itself: the interface needs to know whether the bytes are
        // producible, and an R2 key is not something a client has any business holding. Without it the
        // outbox offered a `.eml` link on every authored send, including ones never dispatched — which
        // answered 409 with a perfectly clear explanation nobody should have had to read.
        `SELECT id, subject, envelope_to, state, state_at, release_at, attempts, last_error,
                transport_message_id, fidelity,
                submitted_key IS NOT NULL AS has_submitted
           FROM send_manifests WHERE org_id = ? ORDER BY sealed_at DESC LIMIT 50`,
      ).bind(who.orgId).all<Record<string, unknown>>();

      // Recipients travel with the sends rather than behind a second request per row.
      //
      // The manifest's own `state` is the *last submission's* state, and on its own it cannot express
      // "one bounced and two were accepted" — which is the distinction Layer 2 is judged on. A UI that
      // rendered only the manifest state would show one chip for a mixed outcome, so the data it needs
      // arrives together with it. One query for up to 50 sends, not fifty.
      const recipients = rows.results.length === 0
        ? { results: [] as Array<Record<string, unknown>> }
        : await env.CATALOG.prepare(
            // Ordered the way a person writes an envelope, not the way SQLite sorts strings. `ORDER BY
            // kind` is alphabetical, which put **bcc first and to last** — so a reader met the blind-copy
            // before the actual addressee, and the summary chips inherited that order too.
            `SELECT manifest_id, kind, address, submission_state, delivery_state, bounce_type, last_error
               FROM send_recipients
              WHERE org_id = ? AND manifest_id IN (${rows.results.map(() => "?").join(", ")})
              ORDER BY manifest_id,
                       CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 WHEN 'bcc' THEN 2 ELSE 3 END,
                       address`,
          ).bind(who.orgId, ...rows.results.map((r) => r.id)).all<Record<string, unknown>>();

      const byManifest = new Map<string, Array<Record<string, unknown>>>();
      for (const row of recipients.results) {
        const key = String(row.manifest_id);
        byManifest.set(key, [...(byManifest.get(key) ?? []), row]);
      }

      return Response.json({
        sends: rows.results.map((send) => ({
          ...send,
          recipients: byManifest.get(String(send.id)) ?? [],
        })),
        daily: await dailySendState(env, clock, who.orgId),
        capability: await cloudflareTransport.capability(env),
      });
    }

    // Releases anything whose hold window has closed. The sweeper alarm does this too; the endpoint
    // exists so an operator does not have to wait for an alarm to see the machinery work.
    if (url.pathname === "/api/sends/dispatch" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({ dispatched: await dispatchDue(env, clock, who.orgId) });
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
      const who = await principalFor(env, clock, request);
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
      const who = await principalFor(env, clock, request);
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

    /**
     * The audit trail, its verification, and the operational log — in the product, because an
     * administrator should not have to open the Cloudflare dashboard to answer "who did that" or
     * "why did that fail".
     *
     * Authenticated. The audit trail names actors and actions across the whole organization, which is
     * a wider view than any single mailbox grants, so it is not something an ordinary read token
     * should imply — §7 evaluates that live, and this is the seam where a narrower audit role slots in
     * when Layer 5 defines one.
     */
    if (url.pathname === "/api/audit" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const action = url.searchParams.get("action");
      const rows = await env.CATALOG.prepare(
        `SELECT id, seq, at, actor_user_id, actor_kind, action, subject, outcome, detail, hash
           FROM audit_entries
          WHERE org_id = ?${action === null ? "" : " AND action = ?"}
          ORDER BY seq DESC LIMIT 200`,
      )
        .bind(...(action === null ? [who.orgId] : [who.orgId, action]))
        .all();
      return Response.json({ entries: rows.results });
    }

    // Verification is the point of a hash chain: a log an administrator has to trust is not evidence.
    if (url.pathname === "/api/audit/verify" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const from = Number(url.searchParams.get("from") ?? "1");
      return Response.json(await verifyChain(env, who.orgId, Number.isFinite(from) ? from : 1));
    }

    if (url.pathname === "/api/logs" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const level = url.searchParams.get("level");
      const rows = await env.CATALOG.prepare(
        `SELECT id, at, level, event, message, detail, request_id FROM log_entries
          ${level === null ? "" : "WHERE level = ?"}
          ORDER BY at DESC LIMIT 200`,
      )
        .bind(...(level === null ? [] : [level]))
        .all();
      const counts = await env.CATALOG.prepare(
        "SELECT level, COUNT(*) AS n FROM log_entries GROUP BY level",
      ).all<{ level: string; n: number }>();
      return Response.json({ entries: rows.results, counts: counts.results });
    }

    if (url.pathname === "/api/me") {
      const who = await principalFor(env, clock, request);
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
      return listMessages(env, clock, request);
    }

    /**
     * A message body, extracted and sanitised (ADR 37).
     *
     * The HTML returned here is for a **sandboxed iframe** and nothing else. The client must render it
     * with no `allow-scripts` and no `allow-same-origin`, because that — not this sanitiser — is the
     * trust boundary. Sanitising reduces what the browser's parser is handed and withholds remote
     * content; it is not a claim that the output is inert.
     */
    const body = /^\/api\/messages\/([^/]+)\/body$/.exec(url.pathname);
    if (body && request.method === "GET") {
      const allowed = await authorize(env, clock, request, body[1]!);
      if (!allowed.ok) return allowed.response;
      const { renderBody } = await import("./render/body.ts");
      return Response.json(await renderBody(await getEvidence(env, allowed.blobKey)));
    }

    // Original .eml, streamed frame by frame so a 25 MiB message is never buffered (#16).
    const raw = /^\/api\/messages\/([^/]+)\/raw$/.exec(url.pathname);
    if (raw && request.method === "GET") {
      const allowed = await authorize(env, clock, request, raw[1]!);
      if (!allowed.ok) return allowed.response;
      return new Response(await streamEvidence(env, allowed.blobKey), {
        headers: {
          "content-type": "message/rfc822",
          // Built rather than interpolated (see headers.ts `safeFilename`). Found by audit rather
          // than by review, and not exploitable today — `authorize()` proves the id exists in D1 and a
          // URL pathname cannot carry a raw CR or LF — but "not reachable" was a property of two other
          // functions rather than of this line.
          "content-disposition": `attachment; filename="${safeFilename(raw[1]!, ".eml")}"`,
        },
      });
    }

    const script = clientScript(url.pathname);
    if (script !== null) return script;

    // Every route the application owns returns the page, because the shell routes on the client and a
    // bookmarked `/outbox` must not 404. The list is shared with `main.tsx` rather than duplicated
    // (`app-routes.ts`), and it is a list rather than a catch-all so a mistyped URL still gets a real 404.
    if (isAppRoute(url.pathname) || url.pathname === "/index.html") {
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
/**
 * The claimed organisation, or null.
 *
 * Tolerates an unreadable catalog, and that is not the same as pretending the Node is unclaimed. A
 * fresh install has no schema at all — `wrangler deploy` provisions the database but does not migrate
 * it — so this query throws, and it used to take `/api/doctor` down with it: the one endpoint whose job
 * is to say what is wrong returned 500 on the most likely way for a Node to be wrong. Measured on a
 * real button install (receipt: `deploy-button-install.md`).
 *
 * Returning null here lets `runDoctor` reach `checkSchema`, which reports the missing tables and the
 * command that fixes them. Nothing is disclosed by doing so: a Node with no tables has no data to
 * protect, and the authentication gate below only applies once an organisation exists.
 */
async function organizationId(env: Env): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
  ).first<{ org_id: string }>().catch(() => null);
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
