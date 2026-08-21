import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { log, trimLogs, verifyChain } from "./audit.ts";
import { CallerError } from "./errors.ts";

import { claimNode } from "./claim.ts";
import { migrate } from "./migrate.ts";
import { applySendingEvent, claimedOrg, type SendingEvent } from "./outbound/events.ts";
import { EvidenceMissing, getEvidence, streamEvidence } from "./evidence-store.ts";
import { acceptInbound } from "./ingress.ts";
import {
  listMessages, authorize, authorizeExport, mailboxesWithRelation, mayRead, maySend, principalFor,
  readableSubjects,
} from "./authz-read.ts";
import { authorizeExportObject, exportsForReport, requestExport, runExport } from "./exports.ts";
import { isAppRoute } from "./app-routes.ts";
import { claim, close, mailboxQueues, queueFor, release, steal } from "./cases.ts";
import {
  assertAdmin, conferredBySupervision, grant, isAdmin, isGrantable, relationsOf, revoke,
} from "./access.ts";
import { closeMatter, listMatters, openMatter } from "./matters.ts";
import { grantsForReport, requestSupervisedRead } from "./supervised.ts";
import { notificationsFor } from "./notifications.ts";
import { deliverDueNotifications } from "./notice-delivery.ts";
import { holdsForReport, placeHold, requestHoldLift } from "./holds.ts";
import { liftDomainPause, requestDomainPause } from "./domain-pause.ts";
import { evaluateBreakers, pausesInForce, RATE_BREAKERS } from "./breakers.ts";
import { createPolicyDraft, editPolicyDraft, publishPolicy, type PolicyConditions } from "./policy.ts";
import {
  decideApproval, pendingApprovals, stageOf, withdrawApproval, type Stages,
} from "./approvals.ts";
import {
  addTeamMember, createTeam, listTeams, membersOf, readTeam, removeTeamMember, renameTeam,
} from "./teams.ts";
import { mergeConversations } from "./merge.ts";
import { sweepResponseClocks } from "./response-clock.ts";
import { setResponseTarget } from "./mailbox-policy.ts";
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
import { releaseButlerSend } from "./butler/release.ts";
import { pausesInForce as butlerPausesInForce } from "./butler/pause.ts";
import { resumeButlerPause } from "./butler/pause-acts.ts";
import { recentRuns, runEffects, runRow } from "./butler/record.ts";
import { inspectRun, replayRun } from "./butler/replay.ts";
import { createButlerDraft, editButlerDraft, publishButler } from "./butlers.ts";
import { cancelSend, dailySendState, dispatchDue, releasePolicyHold } from "./outbound/dispatch.ts";
import { sealManifest } from "./outbound/manifest.ts";
import { resendMayDuplicate, retryEffect, retryOffer } from "./outbound/retry.ts";
import { cloudflareTransport } from "./outbound/transport.ts";
import { formatReconcile, reconcileEvidence } from "./reconcile.ts";
import { resealBatch } from "./reseal.ts";
import { safeFilename } from "./outbound/headers.ts";
import { clientScript, page } from "./ui.ts";

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
        await dispatchDue(env, clock, orgId, cloudflareTransport);
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

      /**
       * `schema` replaced `layer: 1`, and the reason is the point rather than tidiness.
       *
       * `layer` was a hardcoded literal describing how far up the AGENTS.md ladder the *codebase* had got.
       * It went stale the day Layer 2 shipped and stayed wrong through Layer 3, because nothing anywhere
       * could notice: it was a claim about a repository, asserted by a Node that has no way to check it.
       * Exactly the landmine shape — correct once, silently wrong afterwards, with no mechanism to fire.
       *
       * This is a **fact this Node can verify about itself**: the newest migration its own database has
       * applied. It cannot go stale, because it is read rather than declared, and it answers the question an
       * operator actually asks when something is wrong — "is this Node's schema current?" — which the layer
       * number never did.
       */
      const schema = await env.CATALOG.prepare(
        "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
      ).first<{ name: string }>().catch(() => null);

      return Response.json({
        node: "mailda",
        schema: schema?.name ?? null,
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
      // A legal hold refuses this with `E_LEGAL_HOLD` (409) and the central `CallerError` handler renders it.
      // Deliberately not caught here: somebody pressing "discard" is owed the reason, and the alternative —
      // answering `{ deleted: false }` — would say the draft is still there without saying why.
      const deleted = await deleteDraft(env, clock, who.orgId, who.userId, draft[1]!);
      return Response.json({ deleted }, { status: deleted ? 200 : 404 });
    }

    /**
     * Layer 3: the queue, the claim, and access administration.
     *
     * `claim` is what the reply button calls (#42) — claiming and opening the composer are one act, because
     * the guarantee lives in the compare-and-swap rather than in a separate gesture.
     */
    if (url.pathname === "/api/mailboxes" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({ mailboxes: await mailboxQueues(env, who.orgId, who.userId) });
    }

    const mailboxPatch = /^\/api\/mailboxes\/([^/]+)$/.exec(url.pathname);
    if (mailboxPatch && request.method === "PATCH") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // Absent and null are the same request — "promise nothing" — because a PATCH that omitted the field
      // would otherwise silently mean "leave it", and there is only one field to change.
      const raw = body.firstResponseMinutes;
      const minutes = raw === null || raw === undefined ? null : Number(raw);
      return Response.json(
        await setResponseTarget(env, clock, who.orgId, who.userId, mailboxPatch[1]!, minutes),
      );
    }

    if (url.pathname === "/api/cases" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const mailboxId = url.searchParams.get("mailbox");
      if (mailboxId === null) {
        return Response.json(
          { error: "mailbox_required", message: "A queue belongs to one mailbox; name it with ?mailbox=." },
          { status: 400 },
        );
      }
      // Empty rather than forbidden for a mailbox this caller cannot see: §5C keeps an absent thing and an
      // invisible one alike, and a queue is a list, which Blueprint:358 gates before returning counts.
      return Response.json({ cases: await queueFor(env, clock, who.orgId, who.userId, mailboxId) });
    }

    const caseAction = /^\/api\/cases\/([^/]+)\/(claim|steal|release|close)$/.exec(url.pathname);
    if (caseAction && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const [, caseId, action] = caseAction as unknown as [string, string, string];

      if (action === "claim" || action === "steal") {
        const outcome = action === "claim"
          ? await claim(env, clock, who.orgId, who.userId, caseId)
          : await steal(env, clock, who.orgId, who.userId, caseId);

        // Each refusal is a different answer and the interface shows a different thing. `held` carries who
        // and since when, because a person who lost a race is owed the name of whoever won it rather than a
        // bare failure — the same read-back `cancelSend` established.
        if (outcome.kind === "claimed") return Response.json({ claimed: true, case: outcome.case });
        if (outcome.kind === "not_found") {
          return Response.json(
            { claimed: false, error: "not_found", message: "No such case, or you do not have access to it." },
            { status: 404 },
          );
        }
        if (outcome.kind === "closed") {
          return Response.json(
            { claimed: false, error: "closed", message: "This case is closed." },
            { status: 409 },
          );
        }
        return Response.json(
          {
            claimed: false,
            error: "held",
            heldBy: outcome.by,
            heldSince: outcome.since,
            message: `Held by ${outcome.by} since ${outcome.since}. You can take it, and they will be told.`,
          },
          { status: 409 },
        );
      }

      const outcome = action === "release"
        ? await release(env, clock, who.orgId, who.userId, caseId)
        : await close(env, clock, who.orgId, who.userId, caseId);
      const ok = "released" in outcome ? outcome.released : outcome.closed;
      return Response.json(outcome, { status: ok ? 200 : 409 });
    }

    if (url.pathname === "/api/conversations/merge" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const outcome = await mergeConversations(
        env, clock, who.orgId, who.userId,
        String(body.from ?? ""), String(body.into ?? ""),
      );
      // A refusal is 409, not 400: the request was well-formed and the *state* did not permit it, which is
      // the distinction `errors.ts` already draws. The reason names what to resolve.
      return Response.json(outcome, { status: outcome.merged ? 200 : 409 });
    }

    if (url.pathname === "/api/access" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const relation = String(body.relation ?? "");
      if (!isGrantable(relation)) {
        /*
         * A relation this Node *knows* but will not grant here gets told which door works, because "not
         * grantable" is exactly the answer that sends an administrator round the back. `supervised.read` is
         * conferred by a time-boxed grant with two approvers, not by a tuple, and an administrator who is
         * told only "no" grants themselves `mailbox.content.read` instead — which still works, and which
         * doctor now reports as `self_granted_access` (#63).
         */
        const supervised = conferredBySupervision(relation);
        return Response.json(
          {
            error: "not_grantable",
            message: supervised === null
              ? `${relation || "(none)"} is not a grantable relation.`
              : `${supervised} is not granted this way. It is a time-boxed supervised read: POST /api/supervised `
                + `with {"mailboxId","scope","durationSeconds"} and an optional matter, and two people holding `
                + `approval.decide on that mailbox — neither of them you — have to approve it (§7).`,
          },
          { status: 422 },
        );
      }
      const outcome = await grant(env, clock, who.orgId, who.userId, {
        subjectId: String(body.subjectId ?? ""),
        relation,
        objectId: String(body.objectId ?? ""),
      });
      return Response.json(outcome);
    }

    if (url.pathname === "/api/access" && request.method === "DELETE") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const relation = String(body.relation ?? "");
      if (!isGrantable(relation)) {
        return Response.json(
          { error: "not_grantable", message: `${relation || "(none)"} is not a grantable relation.` },
          { status: 422 },
        );
      }
      return Response.json(await revoke(env, clock, who.orgId, who.userId, {
        subjectId: String(body.subjectId ?? ""),
        relation,
        objectId: String(body.objectId ?? ""),
      }));
    }

    /**
     * Everybody in the organization, with what each of them may do (#39, #81).
     *
     * `GET /api/access` answers for **one** subject and defaults to the caller, which is the right shape for
     * "what may I do" and useless for "who may read this mailbox" — the question an administrator actually
     * has, and the one they had no way to ask. Without it there was no list of colleagues anywhere in the
     * product, so granting somebody access meant knowing a user id they could only get from the database.
     *
     * One read rather than a list plus a relations call per person: the tuples are the same rows either way,
     * and N+1 across a directory is how a screen becomes slow at the size where it starts to matter.
     *
     * **`org.admin` only, answering 404.** §5C, and the same answer `/api/policies` gives: who works here
     * and what they can reach is exactly the shape a 403 would confirm the existence of.
     */
    if (url.pathname === "/api/people" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json(
          { error: "not_found", message: "No directory, or you do not have access to it." },
          { status: 404 },
        );
      }
      const people = await env.CATALOG.prepare(
        "SELECT id, email, created_at FROM users WHERE org_id = ? ORDER BY email",
      ).bind(who.orgId).all<{ id: string; email: string; created_at: string }>();
      const tuples = await env.CATALOG.prepare(
        `SELECT subject_id, relation, object_type, object_id FROM relationship_tuples
          WHERE org_id = ? ORDER BY relation`,
      ).bind(who.orgId).all<{
        subject_id: string; relation: string; object_type: string; object_id: string;
      }>();
      const held = new Map<string, Array<{ relation: string; objectType: string; objectId: string }>>();
      for (const row of tuples.results) {
        const list = held.get(row.subject_id) ?? [];
        list.push({ relation: row.relation, objectType: row.object_type, objectId: row.object_id });
        held.set(row.subject_id, list);
      }
      return Response.json({
        people: people.results.map((person) => ({ ...person, relations: held.get(person.id) ?? [] })),
      });
    }

    if (url.pathname === "/api/access" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // Own relations need no admin — knowing what you hold is not privileged. Somebody else's does.
      const subjectId = url.searchParams.get("subject") ?? who.userId;
      if (subjectId !== who.userId && !(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json(
          { error: "not_found", message: "No such subject, or you do not have access to it." },
          { status: 404 },
        );
      }
      return Response.json({ subjectId, relations: await relationsOf(env, who.orgId, subjectId) });
    }

    /**
     * Teams and membership (#73, §28, Layer 3/5).
     *
     * `POST   /api/teams`              create a team. A team with no tuples confers nothing
     * `GET    /api/teams`              every team, with its size — the number a team-scoped policy turns on
     * `GET    /api/teams/:id`          one team and who is in it
     * `POST   /api/teams/:id/rename`   change the name a person picks it out of a list by
     * `POST   /api/teams/:id/members`  put somebody in it, which confers every relation the team holds
     * `DELETE /api/teams/:id/members`  take somebody out, effective on their next request
     *
     * **Five of the six take `org.admin`; `GET /api/teams` is the one exception**, and the line between them
     * is *name and headcount* against *who is in it*. The listing is the organizational chart — a member who
     * reads a shortfall saying "a member of team Legal" has to be able to resolve that name — and the roster
     * is the access map read from the other end, because a team's members are exactly the people every tuple
     * that team holds reaches. `GET /api/access?subject=tm_…` is admin-only for that reason and this is the
     * same question turned round, so it is admin-only too. Each handler carries its own half of the argument;
     * `test/policy-routes.test.ts` asserts both, so the split is enforced rather than described.
     *
     * Among the five, the one worth arguing is `POST /api/teams`: creating a team confers nothing, so the
     * *authority* argument alone would open it up the way `POST /api/matters` is open. It is closed because of
     * the **name** — team names are unique in an organization, so creating one takes a name out of a shared
     * space other people's grants will be chosen from. `src/teams.ts` carries the argument.
     *
     * **Granting to a team is still `POST /api/access`** with the team id as the subject, and there is
     * deliberately no endpoint here that does it. A team is a subject like any other; a second door into
     * `relationship_tuples` would be a second place for *"who can reach this mailbox"* to be answered.
     *
     * **There is no team deletion**, and that is not a gap: a team is a tuple subject, so removing the row
     * would leave grants pointing at an id nothing identifies — conferring nothing while still reading as a
     * grant. Emptying the team and revoking its tuples are the two acts that take its authority away, and both
     * are here. Migration 0032 carries it in full.
     */
    if (url.pathname === "/api/teams" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // An absent name reaches `createTeam` as the empty string and is refused there with the four-part
      // message, rather than defaulted — a team this Node named for somebody would be a label nobody chose.
      return Response.json({ team: await createTeam(env, clock, who.orgId, who.userId, String(body.name ?? "")) });
    }

    if (url.pathname === "/api/teams" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      /*
       * Readable by any member, and that is a decision rather than an oversight.
       *
       * A team is a name and a headcount. It is **not** the access map: which relations a team holds is
       * `GET /api/access?subject=tm_…` and who is in it is `GET /api/teams/:id`, and **both of those are
       * admin-only**. §5C's concern is a listing that hands out what somebody may not see, and "this
       * organization has a team called Finance with four people in it" is the organizational chart rather
       * than the ACL.
       *
       * What it buys is that an author whose send is waiting on *"a member of team Legal"* can find out that
       * such a team exists and how big it is, rather than reading a shortfall naming an id they cannot resolve.
       */
      return Response.json({ teams: await listTeams(env, who.orgId) });
    }

    const teamMembers = /^\/api\/teams\/([^/]+)\/members$/.exec(url.pathname);
    /**
     * Who is in a team (#73, #81).
     *
     * `membersOf` was written with the sentence *"so an administrator can see who a grant to it reaches"*
     * and had no route, so the only readable fact about a team was its member **count**. A screen given a
     * count and a list of people can render a checkbox, and the checkbox cannot be right: it shows unchecked
     * for a member, because nothing told it otherwise. A control that never reflects state is worse than no
     * control, so the roster is readable now.
     */
    if (teamMembers && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ members: await membersOf(env, who.orgId, teamMembers[1]!) });
    }
    if (teamMembers && (request.method === "POST" || request.method === "DELETE")) {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const act = request.method === "POST" ? addTeamMember : removeTeamMember;
      return Response.json({
        membership: await act(
          env, clock, who.orgId, who.userId, teamMembers[1]!, String(body.userId ?? ""),
        ),
      });
    }

    const teamRename = /^\/api\/teams\/([^/]+)\/rename$/.exec(url.pathname);
    if (teamRename && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        team: await renameTeam(env, clock, who.orgId, who.userId, teamRename[1]!, String(body.name ?? "")),
      });
    }

    const oneTeam = /^\/api\/teams\/([^/]+)$/.exec(url.pathname);
    if (oneTeam && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      /*
       * `org.admin`, unlike the listing above, because this is where the roster is.
       *
       * A team's members are exactly the people every tuple that team holds reaches, so answering *"who is in
       * Finance"* answers *"who can decide an approval on that mailbox"* for anybody who can also read
       * `GET /api/teams`. `GET /api/access?subject=…` refuses somebody else's relations to a non-administrator
       * for that reason, and this is the same map read from the subject's end rather than a different one.
       *
       * **403 rather than the §5C 404** the supervised and export listings give, and the difference is that
       * their oracle is still closed: those routes hide *whether there is anything to see*. This team's id,
       * name and size were handed to this same caller by the listing one handler up, so a 404 would be a
       * refusal that misstates a fact the caller already holds — and an error that lies is worse than one that
       * says what is missing. `assertAdmin`'s message names the relation and how to get it.
       */
      await assertAdmin(env, who.orgId, who.userId);
      const team = await readTeam(env, who.orgId, oneTeam[1]!);
      if (team === null) {
        return Response.json(
          { error: "not_found", message: "No such team." },
          { status: 404 },
        );
      }
      return Response.json({ team, members: await membersOf(env, who.orgId, team.id) });
    }

    /**
     * Legal hold (#64, Layer 5). Placing, and asking for a lift.
     *
     * `POST /api/holds`            `org.admin`, alone, immediate, audited `hold.placed`
     * `POST /api/holds/:id/lift`   `org.admin` asks, with a mandatory reason, audited `approval.requested`
     *
     * The asymmetry is the decision, not an accident of what got built: placing only ever preserves, so
     * ceremony in front of it is how evidence is lost in the hour after somebody realises they need it.
     * Lifting re-permits destruction, so it takes **two other people** — the lift request opens a
     * `hold_lift` approval with one stage of two distinct approvers, and the requester is excluded from
     * deciding it. There is deliberately no endpoint that lifts a hold outright: one would contradict #64.
     *
     * **Deciding a lift is `POST /api/approvals/:id/decide`**, unchanged and not duplicated here. That is the
     * point of generalising `approvals` to a subject (migration 0021) rather than giving the lift a plane of
     * its own: an approver's queue, a decision, a withdrawal and the audit trail behind them all work for a
     * lift because they were never about sends.
     *
     * There is deliberately **no list endpoint and no UI**: `doctor` reports every hold in force with its
     * scope, its age, whether its mailbox still exists, whether a lift is pending on it and whether anybody
     * could complete one. A second projection of the same rows would be a parity surface to keep honest for
     * no new answer.
     *
     * `placeHold` refuses a non-admin with `E_NOT_AN_ADMINISTRATOR`, an absent mailbox with `E_NO_MAILBOX`,
     * and an unreadable or inverted window with its own code. `requestHoldLift` refuses an absent hold
     * (`E_NO_HOLD`), a blank reason (`E_HOLD_LIFT_REASON_REQUIRED`), a hold already lifted
     * (`E_HOLD_ALREADY_LIFTED`), a second open request (`E_HOLD_LIFT_PENDING`) and a mailbox with too few
     * approvers (`E_HOLD_LIFT_UNSATISFIABLE`). All of them are `CallerError`s rendered centrally with their
     * four parts.
     */
    /**
     * Every hold in force (#64, #81).
     *
     * `holdsForReport` was written for `doctor` and had no route, so a hold could be **placed** and
     * **lifted by id** and never listed — an administrator who placed one last month had no way to find its
     * id again, and no way to see what their organization is preserving. A legal hold nobody can enumerate
     * is one nobody can answer a court about, which is the whole point of having it.
     *
     * `org.admin`, answering 404: what is under hold names mailboxes and date ranges, and §7 treats the fact
     * of an investigation as disclosable only to the people running it.
     */
    if (url.pathname === "/api/holds" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ holds: await holdsForReport(env, who.orgId) });
    }

    if (url.pathname === "/api/holds" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const optional = (value: unknown): string | null =>
        value === undefined || value === null ? null : String(value);
      const hold = await placeHold(env, clock, who.orgId, who.userId, {
        mailboxId: String(body.mailboxId ?? ""),
        matterId: optional(body.matterId),
        fromDate: optional(body.fromDate),
        toDate: optional(body.toDate),
      });
      return Response.json({ hold });
    }

    const holdLift = /^\/api\/holds\/([^/]+)\/lift$/.exec(url.pathname);
    if (holdLift && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // An absent reason reaches `requestHoldLift` as the empty string and is refused there with the
      // four-part message, rather than being defaulted to something like "no reason given" — which would be
      // this Node inventing a justification for re-permitting destruction.
      const requested = await requestHoldLift(
        env, clock, who.orgId, who.userId, holdLift[1]!, String(body.reason ?? ""),
      );
      return Response.json({ lift: requested });
    }

    /**
     * Matters and supervised reading (#63, §7, Layer 5).
     *
     * `POST /api/matters`             open a matter: a typed, described purpose that can later **close**
     * `GET  /api/matters`             every matter in the organization, open and closed
     * `POST /api/matters/:id/close`   close it. §7's notice to the people whose mail was read is due after this
     * `POST /api/supervised`          ask to read a mailbox you hold nothing on, for a stated time
     * `GET  /api/supervised`          every supervised read that took effect, live or expired
     *
     * **There is no endpoint that grants a supervised read**, and there deliberately never will be: the only
     * thing that makes a request live is two people holding `approval.decide` on that mailbox deciding it at
     * `POST /api/approvals/:id/decide`, which is #61's machinery unchanged. That is the whole return on
     * generalising `approvals` to a subject (0021) — an approver's queue, a decision, a withdrawal and the
     * trail behind them all work for a supervised read because they were never about sends.
     *
     * **Opening a matter takes no administrator**, and that is the decision: the value of the supervised path
     * is that an investigator, HR or counsel can use it *without* being made an administrator, and a matter on
     * its own confers nothing. Closing takes the opener or an `org.admin`, because the investigator is the one
     * party with a reason to leave it open for ever and §7 hangs the notice on the close.
     *
     * `GET /api/matters` is **filtered**, not open: an `org.admin` sees every matter, anybody else sees the
     * ones they opened. A description says *"suspected exfiltration by Dana"*, and §7 makes the notice to Dana
     * due **after the matter closes** — an org-wide listing would deliver it on the day the matter opened, to
     * the one person it must not reach first. The approvers' need for that text is real and is served on the
     * request instead: `GET /api/approvals` carries the cited matter's type and description to the two people
     * being asked. `GET /api/supervised` is admin-only for the neighbouring reason, because it names who has
     * been let into whose mailbox — the organization's access map, and §5C's own example of what a listing
     * must not hand out.
     *
     * **There is no UI**, for the reason the policy and approval planes have none: the shell is Layer 1-3's
     * surface. What `doctor` does show is the state that matters operationally — `self_granted_access`, which
     * is the finding that makes the back door visible beside this front one.
     */
    if (url.pathname === "/api/matters" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // An absent type and an absent description both reach `openMatter` as the empty string and are refused
      // there with the four-part message, rather than defaulted — a matter this Node named for somebody would
      // be a purpose nobody stated.
      return Response.json({
        matter: await openMatter(env, clock, who.orgId, who.userId, {
          type: String(body.type ?? ""),
          description: String(body.description ?? ""),
        }),
      });
    }

    if (url.pathname === "/api/matters" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      /*
       * An administrator sees every matter; anybody else sees the ones they opened.
       *
       * **Not a flat listing, and this is a correction rather than a decision.** The first version returned
       * every matter to every member, justified by *"the approvers read this text before deciding"* — which
       * is an argument about approvers and was implemented as an argument about everybody. A matter's
       * description names the person being examined, and §7 makes the notice to that person due **after the
       * matter closes**; an org-wide listing tells them on the day it opens. The approvers' need is served on
       * the request itself instead: `pendingApprovals` carries the cited matter's type and description, so
       * the two people deciding read the matter they are deciding on.
       *
       * Empty rather than 403 for a non-admin with nothing, because that is what the shape already is: a
       * filtered list, not a refusal, so it discloses no more than "you opened none".
       */
      const all = await isAdmin(env, who.orgId, who.userId);
      return Response.json({
        matters: await listMatters(env, who.orgId, all ? null : who.userId),
      });
    }

    const matterClose = /^\/api\/matters\/([^/]+)\/close$/.exec(url.pathname);
    if (matterClose && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({
        matter: await closeMatter(env, clock, who.orgId, who.userId, matterClose[1]!),
      });
    }

    if (url.pathname === "/api/supervised" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      /*
       * The subject is the caller and there is no field for it. A request on somebody else's behalf would put
       * the reader outside #61's actor exclusion, leaving them free to approve their own access — self-approval
       * reached through a second name, which is precisely what §18 is about.
       *
       * `durationSeconds` is passed through as whatever arrived: `requestSupervisedRead` refuses anything that
       * is not a whole positive number of seconds, and `Number(undefined)` is NaN, which it refuses by naming
       * the field rather than by defaulting to a duration nobody chose.
       */
      return Response.json({
        supervised: await requestSupervisedRead(env, clock, who.orgId, who.userId, {
          mailboxId: String(body.mailboxId ?? ""),
          scope: String(body.scope ?? ""),
          durationSeconds: Number(body.durationSeconds),
          matterId: body.matterId === undefined || body.matterId === null
            ? null
            : String(body.matterId),
        }),
      });
    }

    if (url.pathname === "/api/supervised" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        // §5C: the same answer an organization with no grants would give. A list that 403s tells a caller the
        // access map exists and is worth asking about, which is the oracle every other refusal here avoids.
        return Response.json(
          { error: "not_found", message: "No supervised reads, or you do not have access to them." },
          { status: 404 },
        );
      }
      return Response.json({ supervised: await grantsForReport(env, clock, who.orgId) });
    }

    /**
     * eDiscovery export (#65, §7, §22, Layer 5).
     *
     * `POST /api/exports`                     ask for one. `ediscovery.export`, a matter, a predicate, a bound
     * `GET  /api/exports`                     every export this organization has asked for
     * `POST /api/exports/:id/run`             copy one page, and finish if that page was the last
     * `GET  /api/exports/:id/objects/:name`   download one staged object, re-checking the grant
     *
     * **There is no endpoint that authorizes an export**, exactly as there is none that grants a supervised
     * read: what makes one runnable is two people holding `approval.decide` on that mailbox deciding it at
     * `POST /api/approvals/:id/decide`. Fourth subject kind, same machinery (#61), no second approval path.
     *
     * **The run is a page at a time and the caller loops**, because blueprint:1276 requires an export to use
     * resumable checkpoints and a page is what the cursor advances over. That is also what dissolves the
     * plan arithmetic: a checkpointing run does not need to know its budget in advance, so Free versus Paid
     * changes how many calls an export takes rather than whether it finishes. `done` in the response is the
     * loop's condition, and `E_EXPORT_BOUND_EXCEEDED` is the one refusal that ends it without a manifest.
     *
     * **The download is mediated rather than presigned**, and that is not a preference: the Workers R2
     * binding has no presign method at all, and mediating it is what makes §7's *"revocation terminates
     * export jobs"* enforceable — every object re-asks whether the requester still holds
     * `ediscovery.export` and whether the approval still stands, so a revocation stops a download mid-file.
     *
     * There is deliberately **no UI**, for the reason the policy, approval and supervised planes have none:
     * the shell is Layer 1-3's surface, and an export is a governance act performed by an investigator with
     * a matter open.
     */
    if (url.pathname === "/api/exports" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const optional = (value: unknown): string | null =>
        value === undefined || value === null ? null : String(value);
      /*
       * Every field is passed through as it arrived. `requestExport` refuses an absent matter, an
       * unparseable window and a `maxMessages` that is not a whole positive number below the ceiling, each
       * by naming the field — rather than defaulting, which for a bound would mean this Node choosing how
       * much of somebody's mailbox may leave.
       */
      return Response.json({
        export: await requestExport(env, clock, who.orgId, who.userId, {
          mailboxId: String(body.mailboxId ?? ""),
          matterId: String(body.matterId ?? ""),
          fromDate: optional(body.fromDate),
          toDate: optional(body.toDate),
          subjectContains: optional(body.subjectContains),
          maxMessages: Number(body.maxMessages),
        }),
      });
    }

    if (url.pathname === "/api/exports" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        // §5C, and the same answer `GET /api/supervised` gives for the same reason: this list names who is
        // taking copies of whose mailbox under which matter, which is the organization's investigation map.
        // A 403 would tell a caller the map exists and is worth asking about.
        return Response.json(
          { error: "not_found", message: "No exports, or you do not have access to them." },
          { status: 404 },
        );
      }
      return Response.json({ exports: await exportsForReport(env, who.orgId) });
    }

    const exportRun = /^\/api\/exports\/([^/]+)\/run$/.exec(url.pathname);
    if (exportRun && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // Only the requester may run their own export — `runExport` enforces it and answers 404 otherwise, for
      // the reason its own comment gives: the approval named a person, and somebody else staging the bytes
      // would put a copy in the trail under a name that never asked for it.
      return Response.json({ run: await runExport(env, clock, who.orgId, who, exportRun[1]!) });
    }

    const exportObject = /^\/api\/exports\/([^/]+)\/objects\/([^/]+)$/.exec(url.pathname);
    if (exportObject && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const allowed = await authorizeExportObject(
        env, who.orgId, who, exportObject[1]!, exportObject[2]!,
      );
      if (!allowed.ok) return allowed.response;
      return new Response(await streamEvidence(env, allowed.blobKey), {
        headers: {
          // The manifest is JSON and every other object is a message. Decided from the name rather than
          // from a column, because the name is what the manifest itself records and a second answer would
          // be a second thing to keep true.
          "content-type": exportObject[2] === "manifest.json"
            ? "application/json"
            : "message/rfc822",
          // Built rather than interpolated, for `safeFilename`'s reason one route down: a header value
          // assembled from a path segment is where a CR or LF becomes a second header.
          "content-disposition":
            `attachment; filename="${safeFilename(exportObject[2]!.replace(/\.[a-z]+$/, ""),
              exportObject[2] === "manifest.json" ? ".json" : ".eml")}"`,
        },
      });
    }

    /**
     * Authoring a policy (#60, Layer 5). `org.admin` only, audited as `policy.drafted` and `policy.published`.
     *
     * The minimal surface, and it exists for the reason the legal-hold endpoint above exists: **a policy
     * nobody can write is dead code**, and worse than dead — #60's own governing principle is that a
     * condition backed by no data is a policy that silently never fires. A policy plane with no authoring
     * surface is that failure one level up: the machinery would read as governance while no rule could ever
     * exist. So there are four calls, and no more than four.
     *
     * `POST /api/policies`               create a policy and its first draft
     * `POST /api/policies/:id/draft`     replace the draft — a published version is never edited (#49)
     * `POST /api/policies/:id/publish`   mint the version; refused if the draft changes nothing
     * `GET  /api/policies`               what is live, what is drafted, and what has been superseded
     *
     * **There is deliberately no delete and no unpublish.** Neither is decided: a policy version is what an
     * in-flight send binds, so removing one would leave a manifest pointing at a rule nobody can read, and
     * #62's `max(current) > max(bound)` comparison needs both sides to exist. Withdrawing a rule is
     * expressible today by publishing a version whose outcome is `allow`, which leaves the history intact —
     * that is a smaller product than "retire this policy" and the difference should be visible here rather
     * than discovered by whoever tries it.
     *
     * **There is deliberately no UI**, for the same reason as the hold: the shell is Layer 1–3's surface and
     * a screen for authoring rules is a design question this ticket does not settle. What the shell *does*
     * show is the consequence — the outbox renders `awaiting` and `withheld` with the reason beside them,
     * because a state a person cannot explain is worse than one they cannot set.
     *
     * `GET` is admin-only too, and that is a decision rather than an inherited default: the conditions name
     * mailbox ids and user ids, so the live policy set is a map of who sends where. A responder holding
     * `send.propose` learns from their own outbox that a send was gated and why; they do not need the
     * organization's whole rule set to learn it.
     */
    if (url.pathname === "/api/policies" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        policy: await createPolicyDraft(env, clock, who.orgId, who.userId, {
          name: String(body.name ?? ""),
          outcome: String(body.outcome ?? ""),
          conditions: conditionsFrom(body.conditions),
          stages: stagesFrom(body.stages),
        }),
      });
    }

    const policyDraft = /^\/api\/policies\/([^/]+)\/draft$/.exec(url.pathname);
    if (policyDraft && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        policy: await editPolicyDraft(env, clock, who.orgId, who.userId, policyDraft[1]!, {
          outcome: String(body.outcome ?? ""),
          conditions: conditionsFrom(body.conditions),
          stages: stagesFrom(body.stages),
        }),
      });
    }

    const policyPublish = /^\/api\/policies\/([^/]+)\/publish$/.exec(url.pathname);
    if (policyPublish && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({
        published: await publishPolicy(env, clock, who.orgId, who.userId, policyPublish[1]!),
      });
    }

    if (url.pathname === "/api/policies" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        // §5C: the same answer an absent organization would give. A list that 403s tells a caller the rule
        // set exists and is worth asking about, which is the oracle the outbox's own refusals avoid.
        return Response.json(
          { error: "not_found", message: "No policy set, or you do not have access to it." },
          { status: 404 },
        );
      }
      const rows = await env.CATALOG.prepare(
        `SELECT p.id AS policy_id, p.name, v.id AS version_id, v.version, v.state, v.outcome,
                v.when_mailbox_id, v.when_actor_user_id, v.when_recipient_external, v.when_is_reply,
                v.when_org_daily_volume_min, v.created_at, v.published_at, v.superseded_at
           FROM policy_versions v
           JOIN policies p ON p.id = v.policy_id AND p.org_id = v.org_id
          WHERE v.org_id = ?
          ORDER BY p.name, v.version IS NULL DESC, v.version DESC`,
      ).bind(who.orgId).all<Record<string, unknown>>();
      return Response.json({ policies: rows.results });
    }

    /**
     * Deciding an approval (#61, Layer 5). `approval.decide` on the mailbox, and never your own send.
     *
     * Three calls, and the argument for their existing at all is the one the policy and hold endpoints make:
     * **an approval nobody can decide is dead code**, and worse than dead — a policy that gates a send on a
     * review no channel can perform parks the send while reading as governance, which is the failure #60's
     * governing principle names.
     *
     * `GET  /api/approvals`               what is waiting on you, with the stage set and which stage is open
     * `POST /api/approvals/:id/decide`    approve or deny; a denial is terminal
     * `POST /api/approvals/:id/withdraw`  take back your own approval while the request is incomplete
     *
     * **These three decide legal-hold lifts as well as sends**, and that is why migration 0021 generalised
     * `approvals` to a subject rather than building a second plane: a lift arrives in this queue with its
     * `subjectKind` and the reason it was requested for, and a decision that closes its last stage applies
     * the lift in the same transaction as the `hold.lifted` entry. Nothing here is send-specific except the
     * words `manifestState`, which is absent on any other subject.
     *
     * **There is deliberately no UI**, for the same reason as the policy plane: the shell is Layer 1-3's
     * surface, and an approver's queue is a design question this ticket does not settle. What the shell does
     * show is the consequence — the outbox renders `awaiting` and `withheld` with the reason beside them.
     *
     * **There is deliberately no notification.** Every act here is something a person is waiting on, and #63
     * owns the mechanism: a row is the obligation and an existing cron delivers it. Inventing a second one here
     * is the thing that would have to be undone.
     *
     * The list needs no admin and no §5C dance: it is scoped to the mailboxes the caller holds
     * `approval.decide` on, so a caller with no such mailbox gets an empty list rather than a refusal — there
     * is nothing to hide about the absence of your own work.
     */
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({ approvals: await pendingApprovals(env, who.orgId, who.userId) });
    }

    const approvalDecide = /^\/api\/approvals\/([^/]+)\/decide$/.exec(url.pathname);
    if (approvalDecide && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const decision = String(body.decision ?? "");
      if (decision !== "approve" && decision !== "deny") {
        // Refused rather than defaulted. A missing `decision` defaulting to either value would be this Node
        // deciding somebody else's approval for them, which is the one thing this endpoint must never do.
        return Response.json(
          {
            error: "E_BAD_DECISION",
            message: "E_BAD_DECISION  decision must be approve or deny\n"
              + "  why      an absent decision cannot be defaulted: either default would record a judgement "
              + "nobody made\n"
              + "  fix      send {\"decision\":\"approve\"} or {\"decision\":\"deny\"}",
          },
          { status: 422 },
        );
      }
      return Response.json({
        decided: await decideApproval(env, clock, who.orgId, who.userId, approvalDecide[1]!, decision),
      });
    }

    /**
     * Send circuit breakers (#66, Layer 5). Three windowed rates a Node applies to itself, and one latched
     * pause a person places.
     *
     * `GET  /api/breakers`                 what every rate is at right now, armed or not
     * `POST /api/domain-pauses`            ask two other administrators to stop a domain's mail
     * `GET  /api/domain-pauses`            every pause in force, with its reason and its age
     * `POST /api/domain-pauses/:id/lift`   restart a domain. **One** administrator, alone
     *
     * ## `GET /api/breakers` exists because of AGENTS.md's third principle, not for a dashboard
     *
     * *"A limit developers can hit is a limit they must see"*, and the errors are only half of that: the
     * refusal on a gated send names the budget, the limit, the ask and how long until it clears, but a client
     * composing in a loop should be able to read the rate **before** it gates. An agent that can see
     * `volume: 480 of 500, 900s until the oldest falls out` backs off; an agent that can only see refusals
     * retries into the wall.
     *
     * It needs no administrator and reveals no mail: counts and percentages over the caller's own
     * organization, which is what `doctor` already reports to any authenticated principal.
     *
     * ## Deciding a pause is `POST /api/approvals/:id/decide`, and is not duplicated here
     *
     * Same as the hold lift, the supervised read and the export: `domain_pause` is the fifth approval subject
     * (migration 0026), so the approver's queue, the decision, the withdrawal and the trail behind them all
     * work for it because they were never about sends. There is deliberately **no endpoint that pauses a
     * domain outright** — one would contradict #66's whole asymmetry.
     *
     * The lift, by contrast, *is* a single endpoint one administrator calls alone, and that asymmetry is the
     * decision rather than an accident: placing stops a customer's mail and lifting restarts it, so ceremony
     * belongs in front of the first and nowhere near the second. #64 made the same call in the opposite
     * direction about legal holds, for the same reason.
     */
    if (url.pathname === "/api/breakers" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // No domain, so the pause question is not asked here: the pause listing below is the answer to it, and
      // it is about every domain rather than about one this endpoint would have to be told.
      const decision = await evaluateBreakers(env, clock, who.orgId, null);
      /*
       * The sentence travels with the reading.
       *
       * `RATE_BREAKERS` already carries one plain sentence per breaker — "Too many of the addresses this
       * Node sent to are being refused by their own mail servers" — written where the breaker is defined. A
       * screen that rendered its own wording from `breaker: "bounce_rate"` would be a second copy of those
       * words, drifting from the ones the refusal on a gated send actually uses. So the words ship with the
       * numbers, and there is one place they are written.
       */
      return Response.json({
        breakers: decision.rates.map((rate) => ({
          ...rate, sentence: RATE_BREAKERS[rate.breaker].sentence,
        })),
      });
    }

    if (url.pathname === "/api/domain-pauses" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // Both absent values reach `requestDomainPause` as the empty string and are refused there with the
      // four-part message, rather than being defaulted — a pause with an invented reason would be this Node
      // writing a justification for stopping somebody's mail.
      const requested = await requestDomainPause(
        env, clock, who.orgId, who.userId, String(body.domain ?? ""), String(body.reason ?? ""),
      );
      return Response.json({ pause: requested });
    }

    if (url.pathname === "/api/domain-pauses" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({ pauses: await pausesInForce(env, who.orgId) });
    }

    const pauseLift = /^\/api\/domain-pauses\/([^/]+)\/lift$/.exec(url.pathname);
    if (pauseLift && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // Optional, unlike the reason for placing. Restarting mail is the direction #66 made easy, so a
      // missing reason is accepted and recorded as absent rather than as a phrase nobody said.
      const reason = body.reason === undefined || body.reason === null ? null : String(body.reason);
      return Response.json({
        lifted: await liftDomainPause(env, clock, who.orgId, who.userId, pauseLift[1]!, reason),
      });
    }

    const approvalWithdraw = /^\/api\/approvals\/([^/]+)\/withdraw$/.exec(url.pathname);
    if (approvalWithdraw && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({
        withdrawn: await withdrawApproval(env, clock, who.orgId, who.userId, approvalWithdraw[1]!),
      });
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
        // Absent is a real answer: it means "this mailbox has one address, use it". Only a multi-address
        // mailbox refuses when it is absent, which is what makes adding this field non-breaking.
        senderAddress: body.senderAddress === undefined ? undefined : String(body.senderAddress),
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
      //
      // A legal hold refuses that deletion (#64), and the send must not fail because of it: the manifest is
      // sealed, the message is leaving, and the draft is now being **preserved on purpose**. So the refusal
      // becomes a reported state rather than an error — this is not a swallowed catch, because the caller is
      // told (`draftRetained`), the attempt is already in the audit trail as `hold.blocked`, and any other
      // failure re-raises. Answering 409 here would tell somebody their send failed when it did not.
      let draftRetained = false;
      if (typeof body.draftId === "string" && body.draftId !== "") {
        try {
          await deleteDraft(env, clock, who.orgId, who.userId, body.draftId);
        } catch (error) {
          if (!(error instanceof CallerError) || error.code !== "E_LEGAL_HOLD") throw error;
          draftRetained = true;
        }
      }

      /*
       * Arm the sweeper, because sealing is what creates outbound work and nothing here did it.
       *
       * The alarm now re-arms itself while sends wait (`src/outbox.ts`), but only once it is running — and on
       * an idle Node it is not. Without this, the first send after a quiet spell had no alarm to keep alive
       * and waited for an unrelated poke: an arriving message, or somebody loading a page. That is how this
       * was found, on the live Node, and "your mail leaves when someone opens the app" is the failure §13
       * exists to prevent, reached from the outbound side.
       *
       * `waitUntil` for the same reason as the other two call sites: the person who pressed send is told the
       * manifest is sealed — which is the durable fact — without waiting on the Durable Object.
       */
      ctx.waitUntil(armSweeper(env));
      return Response.json({ ...sealed, capability, draftRetained });
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
        "SELECT submitted_key, fidelity, mailbox_id FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
      ).bind(who.orgId, submitted[1]!)
        .first<{ submitted_key: string | null; fidelity: string; mailbox_id: string }>();

      // §5C: an absent send, one belonging to another organization, and one in a mailbox this caller may
      // not read all answer identically. The third case is #45 — this endpoint streams the **submitted
      // bytes**, so it disclosed the whole message rather than a row about it, and it was bounded by
      // organization alone.
      // The submitted bytes are a whole RFC 5322 message, attachments included, so this is the same act the
      // raw inbound read is and takes the same action rather than a weaker one.
      if (row !== null && !(await mayRead(env, clock, { orgId: who.orgId, userId: who.userId }, row.mailbox_id,
        { action: "supervised.attachment", subject: submitted[1]! }))) {
        return Response.json(
          { error: "not_found", message: "No such send, or you do not have access to it." },
          { status: 404 },
        );
      }
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
      // Gated on `send.propose`, not `mailbox.content.read`, and the difference is deliberate: stopping a
      // send is an outbound act on that mailbox, so it takes the outbound authority. Whoever sealed it
      // holds this by definition, because sealing requires it.
      //
      // Unauthorized answers exactly as unknown does — the same body and status `cancelSend` returns for
      // an id that does not exist — so this cannot be used to probe which mailboxes have held sends.
      // Today the two relations are granted together at claim, so this choice is unobservable; it becomes
      // observable the moment Layer 3 grants them apart.
      const target = await env.CATALOG.prepare(
        "SELECT mailbox_id FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
      ).bind(who.orgId, cancel[1]!).first<{ mailbox_id: string }>();
      const mayCancel = target !== null
        && await maySend(env, { orgId: who.orgId, userId: who.userId }, target.mailbox_id);
      if (!mayCancel) {
        return Response.json({ cancelled: false, reason: "no such send" }, { status: 409 });
      }

      const outcome = await cancelSend(env, clock, who.orgId, cancel[1]!);
      return Response.json(outcome, { status: outcome.cancelled ? 200 : 409 });
    }

    /**
     * The two send-scoped replay modes (#53, §16). `{ "mode": "retry-effect" | "resend-may-duplicate" }`.
     *
     * ## One route, two modes, and the mode is **required** rather than defaulted
     *
     * A default here would be a choice between an act that provably cannot duplicate and one that might, made
     * for the caller by whoever typed the default. So the mode is named, and asking for `retry-effect` where
     * non-acceptance is not proven is **refused with the other mode's name and its consequence** rather than
     * silently upgraded — which is the whole reason there are two names. `resend-may-duplicate` additionally
     * needs `acceptDuplicateRisk: true` and a reason, both refused with the four parts when absent, so no
     * caller in any channel can reach the risky act by omission.
     *
     * ## `send.propose`, like cancel and release, and the unauthorized answer is the unknown one
     *
     * Retrying is an outbound act on the mailbox, so it takes the outbound authority — which whoever sealed
     * the send holds by definition. An unauthorized caller gets exactly what an unknown id gets, so this is
     * not a way to probe which mailboxes have failed sends (§5C). `retryEffect` and `resendMayDuplicate` then
     * re-ask the **author's** authority through `dispatchOne` and `sealManifest`; the two checks are different
     * questions and both are asked.
     *
     * ## Why this is not `/api/butler-runs/:id/replay`
     *
     * The four states these modes turn on are states of a *manifest*, and a manifest outlives every run — most
     * were never proposed by a Butler at all. Hanging them off a run would have made a person's refused send
     * unretryable and a Butler's retryable, which is a distinction with nothing behind it.
     */
    const retrySend = /^\/api\/sends\/([^/]+)\/retry$/.exec(url.pathname);
    if (retrySend && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const target = await env.CATALOG.prepare(
        "SELECT mailbox_id FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
      ).bind(who.orgId, retrySend[1]!).first<{ mailbox_id: string }>();
      const mayRetry = target !== null
        && await maySend(env, { orgId: who.orgId, userId: who.userId }, target.mailbox_id);
      if (!mayRetry) {
        // The same body an unknown id gets, for `cancel`'s reason.
        return Response.json({ error: "E_NO_MANIFEST", what: "no such send" }, { status: 404 });
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.mode === "retry-effect") {
        return Response.json(await retryEffect(env, clock, who.orgId, who.userId, retrySend[1]!));
      }
      if (body.mode === "resend-may-duplicate") {
        return Response.json(await resendMayDuplicate(env, clock, who.orgId, {
          userId: who.userId,
          acceptDuplicateRisk: body.acceptDuplicateRisk === true,
          reason: String(body.reason ?? ""),
        }, retrySend[1]!));
      }
      return Response.json({
        error: "E_RETRY_MODE_UNKNOWN",
        what: `${JSON.stringify(body.mode ?? null)} is not a retry mode`,
        why: "there are two, because there are two epistemic states: one reuses the original idempotency key "
          + "and provably cannot duplicate, and one mints a new key and might",
        fix: 'send {"mode":"retry-effect"} where GET /api/sends offers it, or '
          + '{"mode":"resend-may-duplicate","acceptDuplicateRisk":true,"reason":"…"} where it offers that',
      }, { status: 422 });
    }

    /**
     * Releasing a Butler-proposed send (#50).
     *
     * Beside `cancel` because it is the same shape of act on the same object with the same authority:
     * `send.propose` on the mailbox, which is what composing the message would have taken. #60 gave a policy
     * hold's release to any holder of that relation and this follows it — the gate exists because no person
     * had *seen* the message, not because a stricter authority is owed. `approval.decide` would have made
     * this the approval machinery with none of its guarantees.
     *
     * Answers 409 with the same body for every refusal, exactly as `cancel` does: a manifest that does not
     * exist, one in another organization, one this caller may not send as, and one gated by a **policy**
     * rather than by this Node's Butler gate all answer alike. Otherwise the route is a way to enumerate
     * which sends are waiting on which gate (§5C).
     *
     * `resumed` says whether the parked run was told. A send whose run's retention has expired is still
     * released — the manifest is the gate and it is kept for ever, while instance state is 3 days on Free
     * and 30 on Paid — so `false` here is a fact about the *program*, never about the mail.
     */
    // `releaseSend` rather than `release`, because `release` is already the case-release function imported
    // from `./cases.ts` — and shadowing it here would compile in this block and be a different function
    // three hundred lines away.
    const releaseSend = /^\/api\/sends\/([^/]+)\/release$/.exec(url.pathname);
    /**
     * Releasing a send a **rule** held (#60, #81).
     *
     * Distinct from `/release` below, which is the Butler gate: that one hands a run's proposed send to a
     * person, this one clears a `policy_hold`. Two acts because they answer to two different authorities and
     * clear two different reasons, and a single route matching on `state` alone would let one walk a message
     * past the other's gate.
     */
    const releaseHold = /^\/api\/sends\/([^/]+)\/release-hold$/.exec(url.pathname);
    if (releaseHold && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const outcome = await releasePolicyHold(env, clock, who.orgId, who.userId, releaseHold[1]!);
      return Response.json(outcome, { status: outcome.released ? 200 : 409 });
    }

    if (releaseSend && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const outcome = await releaseButlerSend(env, clock, who.orgId, who.userId, releaseSend[1]!);
      return Response.json(outcome, { status: outcome.released ? 200 : 409 });
    }

    /**
     * What Butlers have done here (#50).
     *
     * `GET /api/butler-runs`        the newest runs: which Butler, which version, which delivery, how it ended
     * `GET /api/butler-runs/:id`    one run and every effect it performed, in order
     *
     * **`org.admin`, not `send.propose`**, and that is the same authority `src/butlers.ts` requires to author
     * one. A run's effect list names case ids, draft ids and manifest ids across every mailbox the Butler
     * touched, so bounding it per mailbox would mean either a partial answer that reads as complete or a
     * query joining four tables to decide visibility row by row. A Butler is governance — the person who may
     * write one is the person who may read what it did.
     *
     * There is deliberately no route that *creates* a run: a run comes from a delivery, and a Butler that
     * could be fired by a request would be an automation with a manual override nobody governed.
     */
    if (url.pathname === "/api/butler-runs" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const limit = Number(url.searchParams.get("limit") ?? "25");
      return Response.json({ runs: await recentRuns(env, who.orgId, Number.isFinite(limit) ? limit : 25) });
    }

    /* ---------------------------------------------------------- authoring a Butler (#77) ------------- */

    /**
     * Writing a Butler, which until now could only be done with direct database access.
     *
     * `createButlerDraft`, `editButlerDraft` and `publishButler` were built, tested and unreachable — nothing
     * in the request path imported them. That inverted #49's central decision: a Butler is **runtime data**
     * precisely so publishing one needs no deploy, and with no route the only way to publish was to insert
     * `butler_versions` rows by hand. Which is the edit `interpret.ts` re-checks against, in its own words:
     * *"a stored AST is still data, and data can be edited by somebody with direct database access."* The
     * defence existed; the front door did not.
     *
     * **None of these four re-decides authority**, and that is deliberate rather than an omission. All three
     * functions call `isAdmin` themselves and throw `E_NOT_AN_ADMINISTRATOR` — a check here as well would be
     * a second opinion about who may author, which is exactly the correspondence problem this repository keeps
     * paying for. The reads below do gate, because they answer rather than act, and §5C makes a refused read
     * indistinguishable from an absent one.
     */
    if (url.pathname === "/api/butlers" && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        butler: await createButlerDraft(env, clock, who.orgId, who.userId, {
          name: String(body.name ?? ""),
          source: String(body.source ?? ""),
        }),
      });
    }

    const butlerDraft = /^\/api\/butlers\/([^/]+)\/draft$/.exec(url.pathname);
    if (butlerDraft && request.method === "PUT") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        butler: await editButlerDraft(env, clock, who.orgId, who.userId, butlerDraft[1]!, {
          source: String(body.source ?? ""),
        }),
      });
    }

    const butlerPublish = /^\/api\/butlers\/([^/]+)\/publish$/.exec(url.pathname);
    if (butlerPublish && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      return Response.json({
        published: await publishButler(env, clock, who.orgId, who.userId, butlerPublish[1]!),
      });
    }

    /**
     * Every Butler, with the version that is live and whether a machine has stopped it.
     *
     * The pause is joined in rather than left to a second request, because *"this Butler is published"* and
     * *"this Butler is running"* are different facts and a list that showed only the first would be the
     * enablement pointer #66 rejected — it would read as *deployed and working* over a Butler a breaker
     * stopped. `pausesInForce` is the same function `triggerButlers` consults, so the list and the gate
     * cannot disagree.
     */
    if (url.pathname === "/api/butlers" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        // §5C, and the same answer `/api/policies` gives: a 403 would confirm that Butlers exist here.
        return Response.json(
          { error: "not_found", message: "No Butlers, or you do not have access to them." },
          { status: 404 },
        );
      }
      const { results } = await env.CATALOG.prepare(
        `SELECT b.id, b.name, b.created_at,
                live.id AS live_version_id, live.version AS live_version, live.published_at,
                draft.id AS draft_version_id
           FROM butlers b
           LEFT JOIN butler_versions live
             ON live.butler_id = b.id AND live.org_id = b.org_id AND live.state = 'published'
           LEFT JOIN butler_versions draft
             ON draft.butler_id = b.id AND draft.org_id = b.org_id AND draft.state = 'draft'
          WHERE b.org_id = ?
          ORDER BY b.name`,
      ).bind(who.orgId).all<Record<string, unknown>>();
      // `butlerPausesInForce`, not `pausesInForce` — the latter is `breakers.ts`'s **domain** pause and is
      // already imported under its own name in this file. Two pause concepts, one spelling.
      const paused = await butlerPausesInForce(env, who.orgId);
      const byButler = new Map(paused.map((row) => [row.butlerId, row]));
      return Response.json({
        butlers: results.map((row) => ({ ...row, pause: byButler.get(String(row.id)) ?? null })),
      });
    }

    /**
     * One Butler's version history.
     *
     * `source_text` travels for the **draft and the live version**, and for nothing else.
     *
     * The first draft of this said "the draft only", which was wrong in a way only opening the screen showed:
     * a Butler with a published version and no draft rendered an **empty editor**. That reads as *this Butler
     * has no program* over one that is live and running, and typing into it would start a replacement from
     * scratch rather than from what the Butler currently does. Editing a published Butler means editing what
     * is running; the route has to send that.
     *
     * **Superseded versions stay withheld**, which is the part worth keeping. Their bodies are immutable and
     * already identified by `source_sha256`, and returning all of them would make one response grow with the
     * number of times anybody ever edited a Butler — a list endpoint that returns every version of every
     * program is an export under another name. At most two bodies travel here, whatever the history.
     */
    const oneButler = /^\/api\/butlers\/([^/]+)$/.exec(url.pathname);
    if (oneButler && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const butler = await env.CATALOG.prepare(
        "SELECT id, name, created_at FROM butlers WHERE org_id = ? AND id = ?",
      ).bind(who.orgId, oneButler[1]!).first<Record<string, unknown>>();
      // A Butler in another organization and one that never existed answer identically (§5C).
      if (butler === null) return Response.json({ error: "not_found" }, { status: 404 });
      const { results } = await env.CATALOG.prepare(
        `SELECT id, version, state, ast_sha256, source_sha256, created_by, created_at,
                published_by, published_at, superseded_at,
                CASE WHEN state IN ('draft', 'published') THEN source_text ELSE NULL END AS source_text
           FROM butler_versions
          WHERE org_id = ? AND butler_id = ?
          ORDER BY COALESCE(version, 2147483647) DESC, created_at DESC`,
      ).bind(who.orgId, oneButler[1]!).all<Record<string, unknown>>();
      return Response.json({ butler, versions: results });
    }

    /**
     * The Butler pause (#75, Layer 5 over Layer 4's substrate).
     *
     * `GET  /api/butler-pauses`             every Butler this Node has stopped, with the figure behind it
     * `POST /api/butler-pauses/:id/resume`  restart one. **One** administrator, alone, with a reason
     *
     * ## There is deliberately no endpoint that pauses a Butler
     *
     * The machine places this one — `triggerButlers`, at the moment a detector's reading goes over its limit
     * — and nothing else does. That is the inverse of `/api/domain-pauses`, where a person asks and two
     * administrators agree, and the reason both are right is in `src/butler/pause-acts.ts`: a breaker that
     * waits for a person is not a breaker, and a pause that stops a customer's *mail* needs somebody to have
     * decided it should.
     *
     * ## Both are `org.admin`, like `/api/butler-runs`
     *
     * A pause names a Butler, a delivery and a windowed figure across every mailbox that Butler touches, and
     * resuming one re-arms a program that proposes sends from other people's mailboxes. That is governance:
     * the person who may publish a Butler is the person who may read what stopped it and decide it is safe
     * again. 404 rather than 403 for a non-administrator, the same answer the run routes give, so the route
     * is not a way to learn whether this Node has Butlers at all (§5C).
     *
     * The reason is **mandatory** and is refused with the four parts rather than defaulted, exactly as
     * `POST /api/domain-pauses` refuses a blank reason for placing one: a resume with an invented
     * justification would be this Node writing down a decision nobody made — and this resume is the only
     * human judgement anywhere in a machine-placed pause.
     */
    if (url.pathname === "/api/butler-pauses" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ pauses: await butlerPausesInForce(env, who.orgId) });
    }

    const butlerResume = /^\/api\/butler-pauses\/([^/]+)\/resume$/.exec(url.pathname);
    if (butlerResume && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      // An absent reason reaches `resumeButlerPause` as the empty string and is refused there with the
      // four-part message. Not defaulted: see the header.
      return Response.json({
        resumed: await resumeButlerPause(
          env, clock, who.orgId, who.userId, butlerResume[1]!, String(body.reason ?? ""),
        ),
      });
    }

    /**
     * The run ledger's two run-scoped replay modes (#53, §16).
     *
     * `GET  /api/butler-runs/:id/inspect`  the frozen program, what the run was given, what it did, and which
     *                                     modes each of its sends offers. **Executes nothing**, and writes
     *                                     nothing but the disclosure entry §7 owes when a supervised grant is
     *                                     what showed the caller the run's content fields
     * `POST /api/butler-runs/:id/replay`   `{ "mode": "re-run" }`. A new run of the same version over the same
     *                                     recorded input, under current policy, authority, approvals and
     *                                     breakers
     *
     * **`org.admin`, like the two read routes beside them**, and for the replay it is the stronger of the two
     * readings: a `re-run` may propose sends from any mailbox the Butler touches, so bounding it per mailbox
     * would authorize an act by one of the mailboxes it can affect. The person who may publish a Butler is the
     * person who may run one again.
     *
     * **`org.admin` is the floor and not the whole check on `inspect`.** A run's recorded input carries the
     * triggering message's subject and sender, which is mail content; `inspectRun` gates those fields on
     * `mailbox.metadata.read` or `mailbox.content.read` on the mailbox the delivery landed in — or a live
     * supervised grant — and redacts them, visibly, for an administrator who holds none of the three. The
     * ids, states and tokens are what `org.admin` alone answers for.
     *
     * **There is no `mode` for the two send-scoped modes here.** `retry-effect` and `resend-may-duplicate` act
     * on a manifest, a manifest outlives every run, and most manifests never had one — so they are
     * `POST /api/sends/:id/retry` with `send.propose` on the mailbox, which is the authority composing the
     * message took. Putting them here would have made a human's refused send unretryable while a Butler's was
     * retryable, which is a distinction with nothing behind it.
     *
     * An unknown mode is refused with the modes that exist rather than defaulted, because a default here is a
     * choice between an act that cannot duplicate and one that can.
     */
    const inspectRunPath = /^\/api\/butler-runs\/([^/]+)\/inspect$/.exec(url.pathname);
    if (inspectRunPath && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const inspected = await inspectRun(env, clock, who, inspectRunPath[1]!);
      if (inspected === null) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(inspected);
    }

    const replayRunPath = /^\/api\/butler-runs\/([^/]+)\/replay$/.exec(url.pathname);
    if (replayRunPath && request.method === "POST") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.mode !== "re-run") {
        return Response.json({
          error: "E_REPLAY_MODE_UNKNOWN",
          what: `${JSON.stringify(body.mode ?? null)} is not a replay mode this route performs`,
          why: "this route runs a program again; `inspect` is a GET on this run and the two send-scoped "
            + "modes act on a manifest, which outlives every run",
          fix: 'send {"mode":"re-run"}, GET /api/butler-runs/:id/inspect, or '
            + "POST /api/sends/:id/retry for retry-effect and resend-may-duplicate",
        }, { status: 422 });
      }
      return Response.json(await replayRun(env, clock, who.orgId, who.userId, replayRunPath[1]!));
    }

    const oneRun = /^\/api\/butler-runs\/([^/]+)$/.exec(url.pathname);
    if (oneRun && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      if (!(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const run = await runRow(env, who.orgId, oneRun[1]!);
      if (run === null) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ run, effects: await runEffects(env, who.orgId, oneRun[1]!) });
    }

    if (url.pathname === "/api/sends" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // Subjects are the user plus every team they belong to, which is what `hasRelation` and
      // `listMessages` both do. A relation held through a team is held.
      const subjects = await readableSubjects(env, who);
      const subjectPlaceholders = subjects.map(() => "?").join(", ");
      const rows = await env.CATALOG.prepare(
        // `has_submitted` rather than the key itself: the interface needs to know whether the bytes are
        // producible, and an R2 key is not something a client has any business holding. Without it the
        // outbox offered a `.eml` link on every authored send, including ones never dispatched — which
        // answered 409 with a perfectly clear explanation nobody should have had to read.
        //
        // The mailbox bound is the fix for #45. This read was `WHERE org_id = ?` and nothing else, so any
        // authenticated member received every send from every mailbox — subjects, recipients, and the
        // receiving server's own words about a customer's address. `listMessages` has always bounded the
        // inbound equivalent this way; the outbound list simply never did, and with one user per Node the
        // two returned identical rows so nothing looked wrong.
        //
        // Authorization is **inside the query**, not a filter applied after (§5, ADR 11): a row the caller
        // may not see must never be counted, sliced or paginated, and a post-filter gets that wrong the
        // first time somebody adds a LIMIT above it.
        `SELECT id, subject, envelope_to, state, state_at, release_at, attempts, last_error,
                transport_message_id, fidelity, state_reason, policy_outcome,
                submitted_key IS NOT NULL AS has_submitted
           FROM send_manifests
          WHERE org_id = ?
            AND mailbox_id IN (
              SELECT object_id FROM relationship_tuples
               WHERE org_id = ? AND subject_id IN (${subjectPlaceholders})
                 AND object_type = 'mailbox' AND relation = 'mailbox.content.read'
            )
          ORDER BY sealed_at DESC LIMIT 50`,
      ).bind(who.orgId, who.orgId, ...subjects).all<Record<string, unknown>>();

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
          /*
           * Which replay mode this send offers, or none (#53). **Free**: `retryOffer` is pure and every
           * column it reads — `state`, `fidelity`, `submitted_key IS NOT NULL` — was already in the `SELECT`
           * above for other reasons, so the outbox names the modes without a second query.
           *
           * It travels with the listing rather than behind a per-send request because that is what makes the
           * distinction visible where somebody acts on it. AGENTS.md §3's rule is that a limit a developer can
           * hit is one they must see; this is the same rule for a *mode*, and the failure it prevents is a
           * client that offers "retry" on everything and discovers per send which of the two it got.
           */
          retry: retryOffer({
            state: String(send.state),
            fidelity: String(send.fidelity),
            hasSubmitted: Number(send.has_submitted) === 1,
          }),
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
      // Bounded to the mailboxes this caller may send as. Org-wide was wrong on two counts: the result
      // names every manifest it touched, and a held send past its release_at is still cancellable — so
      // forcing the sweep ended other people's chance to stop their own mail. `send.propose` rather than
      // `mailbox.content.read`, matching cancel: releasing a send is an outbound act.
      //
      // The sweeper alarm still sweeps everything, because it is the Node acting for itself with no
      // principal to bound it. This endpoint exists only so an operator need not wait for that alarm.
      const dispatchable = await mailboxesWithRelation(
        env, { orgId: who.orgId, userId: who.userId }, "send.propose",
      );
      return Response.json({
        dispatched: await dispatchDue(env, clock, who.orgId, cloudflareTransport, 20, dispatchable),
      });
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
     * The in-product delivery of §7's notice, and of #61's approval requests (#63 part B).
     *
     * **In-product rather than by mail**, and that follows rather than being chosen: `outbound/transport.ts`
     * already has to catch Cloudflare's *destination address is not a verified address*, so a legal
     * obligation carried by outbound mail is one defeated by a mail-routing setting. This endpoint has no
     * such dependency.
     *
     * There is deliberately **no dismiss, no mark-read and no delete.** A notice a person can clear is a
     * notice an administrator can clear, and §7 requires the notification not be disableable by the
     * investigator. The only way one leaves this list is by leaving the table, which is a row whose creation
     * rode with an audit entry — see `doctor`'s `supervision_notice_missing`.
     */
    if (url.pathname === "/api/notifications" && request.method === "GET") {
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      // Subjects are the person plus every team they belong to, which is what every other read here does. A
      // mailbox read through a team is a mailbox whose notices reach that team's members.
      const subjects = await readableSubjects(env, who);
      return Response.json({ notifications: await notificationsFor(env, who, subjects) });
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
      // `supervised.opened` — §7's *result opened*. The body is one message's content, which is what
      // distinguishes it from the raw read below.
      const allowed = await authorize(env, clock, request, body[1]!, "supervised.opened");
      if (!allowed.ok) return allowed.response;
      const { renderBody } = await import("./render/body.ts");
      return Response.json(await renderBody(await getEvidence(env, allowed.blobKey)));
    }

    /**
     * Original `.eml`, streamed frame by frame so a 25 MiB message is never buffered (#16) — and, since
     * #65, **the single-message export**.
     *
     * `authorizeExport` rather than `authorize`, and the difference is the whole of #65's smaller half. This
     * route produces a complete RFC822 copy with `content-disposition: attachment`, and until now it did so
     * on the strength of `mailbox.content.read` alone and **recorded nothing** — so *"has anybody taken a
     * copy of this message off the Node"* had no answer. It now takes `message.export` as well and appends
     * `message.exported` before any byte moves. The supervised `.eml` path is unchanged: a grant of scope
     * `content` satisfies both checks and still emits `supervised.attachment`.
     *
     * `/api/messages/:id/body` deliberately keeps `authorize`: rendering one message's text inside the
     * product is a read, not a copy leaving, which is the boundary the two permissions draw.
     */
    const raw = /^\/api\/messages\/([^/]+)\/raw$/.exec(url.pathname);
    if (raw && request.method === "GET") {
      const allowed = await authorizeExport(env, clock, request, raw[1]!);
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

/**
 * A policy's five conditions out of a JSON body, and nothing else.
 *
 * Five named reads rather than a spread, deliberately. `{ ...body.conditions }` would accept `dataClass` or
 * `device` — a field #60 named **absent** because no data answers it — and store it nowhere while the caller
 * believed a rule had been written. That is exactly *"a condition backed by no data is a policy that silently
 * never fires"*, arriving through the API instead of through the schema, and the five-column table would not
 * have caught it because the extra key would never reach a column.
 *
 * An unrecognised key is therefore **ignored rather than refused**, and that is the one weak spot here worth
 * naming: a caller who spells `mailbox_id` instead of `mailboxId` publishes an unconditional policy and is
 * told nothing. Refusing unknown keys is the better behaviour and it belongs with the command contract in
 * `packages/contract`, which is where every channel's validation is generated from — a second hand-written
 * validator in this file is the correspondence problem `errors.ts` already rejected once.
 */
function conditionsFrom(raw: unknown): PolicyConditions {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const text = (value: unknown): string | null | undefined =>
    value === undefined ? undefined : value === null ? null : String(value);
  const flag = (value: unknown): boolean | null | undefined =>
    value === undefined ? undefined : value === null ? null : Boolean(value);
  const count = (value: unknown): number | null | undefined =>
    value === undefined ? undefined : value === null ? null : Number(value);
  return {
    mailboxId: text(source.mailboxId),
    actorUserId: text(source.actorUserId),
    recipientExternal: flag(source.recipientExternal),
    isReply: flag(source.isReply),
    orgDailyVolumeMin: count(source.orgDailyVolumeMin),
  };
}

/**
 * A policy's approval stages out of a JSON body: what each stage requires, in review order (#61, #73).
 *
 * An array, because the position **is** the ordinal — `[1, 1]` is sequential review by two people, `[2]` is
 * parallel dual control, and `[{"count":1,"team":"tm_…"},{"count":1,"team":"tm_…"}]` is §18's separation of
 * *duty*: one from finance, then one from legal.
 *
 * ## A bare number is sugar for an unconstrained stage, and that is one spelling rather than two
 *
 * `2` and `{"count":2}` arrive as the same `Stage`, so there is exactly one **stored** form — which is the
 * property #61 protects when it normalises the implicit stage away, reached one layer out. What the sugar buys
 * is that every policy body written before teams existed still means what it meant, and a rule with no team
 * constraint is not made to carry an object to say so.
 *
 * Coerced rather than trusted, for the reason `conditionsFrom` coerces its volume floor: JSON from a form
 * carries `"2"`, and `normaliseStages` demands an integer, so an uncoerced value would be refused with a
 * message about its own value being unusable.
 *
 * `undefined` and `[]` both mean the default, which is one stage of count 1. Anything that is not an array is
 * `undefined` rather than an error here: `normaliseStages` refuses what it cannot use, and one refusal beats
 * two. A `team` that is absent, null or not a string becomes `null` — no constraint — and an *empty* string is
 * passed through as an empty string so `normaliseStages` can refuse it, because `""` is a typo rather than a
 * choice and coercing it to null would silently weaken the rule its author wrote.
 */
function stagesFrom(raw: unknown): Stages | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((value) => {
    if (typeof value !== "object" || value === null) return stageOf(Number(value));
    const stage = value as Record<string, unknown>;
    const team = stage.team ?? stage.teamId;
    return stageOf(Number(stage.count), typeof team === "string" ? team : null);
  });
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
      return "That bootstrap secret does not match. It was shown once by `mailda claim-secret`, and only its hash is stored — seed again if it is lost.";
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
