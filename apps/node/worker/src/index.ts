import { createSystemCtx } from "@mailda/runtime";

import { log, trimLogs } from "./audit.ts";
import { CallerError } from "./errors.ts";

import { refuseCrossSite } from "./csrf.ts";
import { refuseUnknownFields } from "./request-shape.ts";
import { applySendingEvent, claimedOrg, type SendingEvent } from "./outbound/events.ts";
import { EvidenceMissing } from "./evidence-store.ts";
import { acceptInbound } from "./ingress.ts";
import { isAppRoute } from "./app-routes.ts";
import { deliverDueNotifications } from "./notice-delivery.ts";
import { sweepResponseClocks } from "./response-clock.ts";
import { dispatchDue } from "./outbound/dispatch.ts";
import { chooseTransport } from "./outbound/transport.ts";
import { backfillBodyIndex, backfillSearchIndex } from "./search-backfill.ts";
import { withSecurityHeaders } from "./security-headers.ts";
import { clientAsset } from "./ui.ts";
import { resolve, type Call, type Handler } from "./router.ts";
import { HANDLERS } from "./routes/index.ts";
import { armSweeper, hashHex, unauthenticated } from "./routes/support.ts";
import { principalFor } from "./authz-read.ts";

export { OutboxSweeper } from "./outbox.ts";
export { KeyVault } from "./keyvault.ts";
/**
 * The Butler engine (#50). One generic `WorkflowEntrypoint` for every Butler on this Node, exported here
 * because `wrangler.jsonc`'s `[[workflows]]` block names it by `class_name` and the platform resolves it off
 * the bundle's entry module — exactly as it does the two Durable Objects above.
 */
export { ButlerRun } from "./butler/run.ts";

/**
 * The Mailda Node. One Worker (ADR 18).
 *
 * Layer 1 of the ladder in AGENTS.md: receive one real internet message, store it
 * losslessly, and show it to one authorized human.
 */
/**
 * The Worker.
 *
 * Named rather than exported anonymously so that `/mcp` can re-enter it: an MCP tool call dispatches back
 * through `handler.fetch`, which is what makes "the tool goes through this Node's own routes" true of the
 * error translation and the cache headers as well as of the routing. Re-entering at `route` instead — the
 * first attempt — skipped the `catch` that turns a `CallerError` into a four-part refusal, so a tool call
 * that should have answered 422 with a remedy answered 500 with nothing.
 */
const handler = {
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

  /**
   * The cron sweep (#41, #63 part B). Two jobs: recording first-response breaches, and delivering the
   * notifications that have fallen due.
   *
   * Deliberately thin, and deliberately two *scans*. Cron documents no retry, so anything here has to be
   * repaired by the next minute's run rather than depending on this one — which a query over due rows is and
   * a cursor would not be.
   *
   * **The two jobs are independent and are kept that way.** Each has its own `try`, so a failure in one does
   * not cost the other a run — a §7 notice is a legal obligation and a first-response breach is a promise to a
   * customer, and neither is a good reason to drop the other. The alternative, one `try` around both, is how
   * a scheduled handler quietly stops doing its second job.
   *
   * Errors are logged rather than thrown. A throw here reaches Cloudflare's scheduled-event machinery, which
   * has no retry to offer and no operator watching it; the log is inside the product where `doctor` can see
   * it, and the next minute tries again regardless.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const clock = createSystemCtx();
    ctx.waitUntil((async () => {
      const orgId = await claimedOrg(env).catch(() => null);
      // An unclaimed Node has no cases to sweep and nobody to notify. Not an error, and not worth a log line
      // every minute for the lifetime of an uninstalled Node.
      if (orgId === null) return;

      try {
        const outcome = await sweepResponseClocks(env, clock, orgId);
        if (outcome.breached.length > 0) {
          await log(env, clock, {
            level: "warn",
            event: "sla.first_response_breached",
            message: `${outcome.breached.length} case(s) passed their first-response time unanswered.`,
            orgId,
            detail: { cases: outcome.breached.slice(0, 20) },
          });
        }
      } catch (error) {
        await log(env, clock, {
          level: "error",
          event: "sla.sweep_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
        }).catch(() => undefined);
      }

      try {
        /*
         * Catching the search index up on mail that arrived before it existed (#107).
         *
         * Bounded and resumable, so this is safe to run every minute forever: once the archive is indexed it
         * writes nothing and costs one query. Logged **only when it did something**, for the reason the notice
         * sweep below gives — an idle Node should write nothing — and at `info`, because a backfill making
         * progress is not a fault.
         *
         * A failure here is `warn` rather than `error`: unindexed mail is unsearchable, not lost, and it stays
         * reachable by paging. `doctor`'s `search_index_backlog` is what says how much is outstanding, so the
         * gap is a number an operator can read rather than a log line that scrolls past.
         */
        const indexed = await backfillSearchIndex(env);
        if (indexed > 0) {
          await log(env, clock, {
            level: "info",
            event: "search.backfilled",
            message: `Indexed ${indexed} message(s) that arrived before the search index existed.`,
            orgId,
            detail: { indexed },
          });
        }
      } catch (error) {
        await log(env, clock, {
          level: "warn",
          event: "search.backfill_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
        }).catch(() => undefined);
      }

      try {
        /*
         * The body index's backfill (#107 L2), which is a different animal from the one above.
         *
         * That one is a single `INSERT … SELECT` inside D1. This one reads R2, unwraps a vault key, decrypts
         * and parses MIME **per message**, so it is bounded to 25 a minute rather than 500 and a long archive
         * catches up over hours. `doctor`'s `body_index_backlog` is what makes that visible instead of
         * mysterious.
         *
         * Its own try block, so a failure here does not stop the metadata backfill or the notice sweep — the
         * two indexes catch up independently and one being stuck is not a reason for the other to be.
         */
        const bodies = await backfillBodyIndex(env, clock);
        if (bodies > 0) {
          await log(env, clock, {
            level: "info",
            event: "search.bodies_backfilled",
            message: `Indexed the bodies of ${bodies} message(s) that predate the body index.`,
            orgId,
            detail: { settled: bodies },
          });
        }
      } catch (error) {
        await log(env, clock, {
          level: "warn",
          event: "search.body_backfill_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
        }).catch(() => undefined);
      }

      try {
        const notices = await deliverDueNotifications(env, clock, orgId);
        // Logged only when it did something, so an idle Node writes nothing — and logged at `info` because a
        // delivered notice is not a fault. `batchWasFull` is the one signal that would tell an operator the
        // tripwire in `supervised-notice-scan.md` is binding rather than comfortable.
        if (notices.delivered > 0) {
          await log(env, clock, {
            level: "info",
            event: "notifications.delivered",
            message: `${notices.delivered} notification(s) delivered.`,
            orgId,
            detail: { delivered: notices.delivered, batchWasFull: notices.batchWasFull },
          });
        }
      } catch (error) {
        // Loud, and `error` rather than `warn`: an undelivered §7 notice is an obligation this Node is not
        // discharging, and `doctor`'s supervision_notices_overdue counts what this failure leaves behind.
        await log(env, clock, {
          level: "error",
          event: "notifications.scan_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
          orgId,
        }).catch(() => undefined);
      }

      /*
       * The outbound backstop, and it is here rather than beside each act for a reason worth stating.
       *
       * `OutboxSweeper`'s alarm is the fast path and re-arms itself while sends wait — but only once it is
       * running, and on an idle Node it is not. Sealing arms it. **Clearing a gate does not**, and three
       * separate acts move a manifest from a gated state to `held`: an approval completing
       * (`approvals.ts`), a Butler run's send being released (`butler/release.ts`), and a retry
       * (`outbound/retry.ts`). None of them armed anything, so an approved send sat `held` with
       * `attempts = 0` until something unrelated poked the Node — measured, on a fixture Node, after a
       * second approver cleared it.
       *
       * Arming from those three would work and would be wrong: it is a list, and the fourth act to clear a
       * gate would not be on it. That is the correspondence problem this repository keeps paying for, and
       * the same shape as the binding allowlists in #71. One sweep on a schedule that already runs covers
       * every act that exists and every act that does not yet, and costs one query a minute on an idle Node
       * — against the alternative of mail that leaves when somebody happens to open the app.
       *
       * The alarm stays the fast path: this bounds the delay at one minute, it does not replace it.
       */
      try {
        await dispatchDue(env, clock, orgId, await chooseTransport(env));
      } catch (error) {
        await log(env, clock, {
          level: "error",
          event: "outbound.sweep_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
          orgId,
        }).catch(() => undefined);
      }
    })());
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

  /**
   * Every response this Node gives a browser leaves through here, which is why the two response-wide
   * headers are applied here and nowhere else (#97).
   *
   * `withSecurityHeaders` moved in one level from where `noStore` used to sit, and so did `noStore`. Both
   * used to be applied *inside* the try, which meant the three error returns each had to remember them —
   * and the unhandled-500 return did not, so the response for the worst thing that can happen to a request
   * was the one response with no cache directive on it. A wrapper around the whole thing cannot be
   * forgotten by a return statement that has not been written yet.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    return withSecurityHeaders(noStore(url, await answer(request, env, ctx)));
  },
};

export default handler;

/**
 * The request, answered — routing plus the four ways a request can fail.
 *
 * Split out of `fetch` so the wrapper above has something to wrap. Nothing here sets a header that every
 * response carries; that is the point of the split.
 */
async function answer(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const clock = createSystemCtx();
  const requestId = clock.id("req");
  try {
    /*
     * The contract, applied rather than described (#93).
     *
     * Inside this `try` and before the route, which is a deliberate position on two counts. Before the
     * route and before authentication, for the reason `noStore` and the security headers sit one level out:
     * a check each handler has to remember is one that will be forgotten, and this one fails **silently**
     * when forgotten — a misspelled policy condition used to publish a rule matching every send in the
     * organization and report it as created. And inside the `try`, so its refusal travels the same
     * `CallerError` path as every other refusal and arrives as a four-part 422 rather than needing a second
     * copy of this catch.
     *
     * `handleMcp` re-enters `handler.fetch`, so it reaches here too — the machine surface is held to the
     * same closed set rather than to a second definition of it.
     */
    /*
     * Before the body is even read: a cross-site mutation should not reach a schema, a handler or a
     * database. Same position and same argument as the closed-set check below it (#93) — a guard each
     * handler has to remember is one that will be forgotten, and this one fails silently when forgotten.
     */
    refuseCrossSite(request, new URL(request.url));
    await refuseUnknownFields(request, new URL(request.url).pathname);
    return await route(request, env, ctx);
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
      return Response.json(
        { error: "evidence_missing", message: error.message, requestId },
        { status: 500 },
      );
    }

    if (error instanceof CallerError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
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
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const clock = createSystemCtx();

  const reenter = (inner: Request) => handler.fetch(inner, env, ctx);
  const found = resolve(request.method, url.pathname);
  if (found !== null) {
    // The principal, once, for every route the registry says needs one. An open route is handed `null` and
    // looks for itself if it wants to — `/mcp` admits a stranger and `/api/doctor` reduces its report.
    const who = found.open ? null : await principalFor(env, clock, request);
    if (!found.open && who === null) return unauthenticated();
    // `found.params` is what the template captured, and the template is what typed the handler's `params`;
    // the cast is the one place the two meet, and `resolve` is the function that keeps them in step.
    const handler = HANDLERS[found.key] as Handler;
    return handler({
      request, env, ctx, clock, url, params: found.params as Call["params"], who: who as Call["who"], reenter,
    });
  }

  const asset = clientAsset(url.pathname);
  if (asset !== null) return asset;

  // Every route the application owns returns the page, because the shell routes on the client and a
  // bookmarked `/outbox` must not 404. The list is shared with `main.tsx` rather than duplicated
  // (`app-routes.ts`), and it is a list rather than a catch-all so a mistyped URL still gets a real 404.
  if (isAppRoute(url.pathname)) {
    return HANDLERS["GET /index.html"]({ request, env, ctx, clock, url, params: {}, who: null, reenter });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
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
 * #4's binding rule. `/health` and the client assets are deliberately excluded: one is
 * non-disclosive by design and the other is meant to be cached briefly.
 *
 * Since #97 it is applied one level further out, in `fetch` rather than inside the try, because the
 * error returns were each remembering it separately and the unhandled-500 return had forgotten.
 */
function noStore(url: URL, response: Response): Response {
  if (!url.pathname.startsWith("/api/")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("vary", "cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
