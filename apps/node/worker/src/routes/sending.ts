import type { Bytes } from "@mailda/evidence";

import { CallerError, unprocessable } from "../errors.ts";
import { auditedBatch } from "../audit.ts";
import { streamEvidence } from "../evidence-store.ts";
import { authorizeSendExport, mailboxesWithRelation, maySend, readableSubjects } from "../authz-read.ts";
import { isAdmin } from "../access.ts";
import { liftDomainPause, requestDomainPause } from "../domain-pause.ts";
import { evaluateBreakers, pausesInForce, RATE_BREAKERS } from "../breakers.ts";
import { deleteDraft } from "../drafts.ts";
import { capped } from "../list-cap.ts";
import { sponsorTerm } from "../delegation.ts";
import { releaseButlerSend } from "../butler/release.ts";
import { cancelSend, dailySendState, dispatchDue, releasePolicyHold } from "../outbound/dispatch.ts";
import { sealManifest } from "../outbound/manifest.ts";
import { resendMayDuplicate, retryEffect, retryOffer } from "../outbound/retry.ts";
import { chooseTransport } from "../outbound/transport.ts";
import { safeFilename } from "../outbound/headers.ts";
import { addressList, armSweeper } from "./support.ts";
import type { Some } from "../router.ts";

/** The outbox shows this many sends, newest first, and says when older ones exist. */
const SEND_LIST_CAP = 50;

export const sending = {
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
  "GET /api/breakers": async ({ env, clock, who }) => {
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
  },

  "POST /api/domain-pauses": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Both absent values reach `requestDomainPause` as the empty string and are refused there with the
    // four-part message, rather than being defaulted — a pause with an invented reason would be this Node
    // writing a justification for stopping somebody's mail.
    const requested = await requestDomainPause(
      env, clock, who.orgId, who.userId, String(body.domain ?? ""), String(body.reason ?? ""),
    );
    return Response.json({ pause: requested });
  },

  "GET /api/domain-pauses": async ({ env, who }) => {
    return Response.json({ pauses: await pausesInForce(env, who.orgId) });
  },

  "POST /api/domain-pauses/:pauseId/lift": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Optional, unlike the reason for placing. Restarting mail is the direction #66 made easy, so a
    // missing reason is accepted and recorded as absent rather than as a phrase nobody said.
    const reason = body.reason === undefined || body.reason === null ? null : String(body.reason);
    return Response.json({
      lifted: await liftDomainPause(env, clock, who.orgId, who.userId, params.pauseId, reason),
    });
  },

  /*
   * The suppression list (0058): derived from the provider's events, so there is nothing to place — only
   * a list, and a lift that vouches for one address with a reason.
   */
  "GET /api/suppressions": async ({ env, who }) => {
    const { listSuppressions, SUPPRESSION_LIST_CAP } = await import("../suppression.ts");
    const { rows, truncated } = capped(await listSuppressions(env, who.orgId, who.userId), SUPPRESSION_LIST_CAP);
    return Response.json({ suppressed: rows, truncated });
  },

  "POST /api/suppressions/lift": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { liftSuppression } = await import("../suppression.ts");
    return Response.json(
      await liftSuppression(env, clock, who.orgId, who.userId, String(body.address ?? ""), String(body.reason ?? "")),
    );
  },

  /**
   * Outbound (Layer 2). Sealing and dispatching are separate endpoints because they are separate
   * acts (ADR 35) — which is what makes undo-send honest rather than a claim about recall.
   */
  "POST /api/sends": async ({ request, env, ctx, clock, who }) => {

    // §14: whether this Node can send is answerable *before* composing, not at submit.
    const capability = await (await chooseTransport(env)).capability(env);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sealed = await sealManifest(env, clock, who.orgId, {
      mailboxId: String(body.mailboxId ?? ""),
      authorUserId: who.userId,
      inReplyToMessageId: body.inReplyToMessageId === undefined ? undefined : String(body.inReplyToMessageId),
      forwardOfMessageId: body.forwardOfMessageId === undefined || body.forwardOfMessageId === null
        ? undefined : String(body.forwardOfMessageId),
      // `[{filename, contentType, contentBase64}]` (0060). Decoded here and judged at the seal; a part that
      // is not base64 is refused as a shape rather than sent as whatever `atob` made of it.
      attachments: Array.isArray(body.attachments)
        ? (body.attachments as unknown[]).map((one) => (typeof one === "object" && one !== null ? one : {}) as Record<string, unknown>).map((one) => ({
          filename: String(one.filename ?? "attachment"),
          contentType: String(one.contentType ?? "application/octet-stream"),
          content: decodeBase64(String(one.contentBase64 ?? "")),
        }))
        : undefined,
      // Absent is a real answer: it means "this mailbox has one address, use it". Only a multi-address
      // mailbox refuses when it is absent, which is what makes adding this field non-breaking.
      senderAddress: body.senderAddress === undefined ? undefined : String(body.senderAddress),
      to: addressList(body.to) ?? [],
      cc: addressList(body.cc),
      bcc: addressList(body.bcc),
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
  },

  /**
   * The exact bytes Mailda submitted, streamed frame by frame (#16).
   *
   * §12 invariant 2 makes a materialized provider-submission representation immutable evidence, and
   * storing it while providing no way to read it back is barely better than not storing it — the
   * point of the record is that an operator can *produce* it. Present only for the `authored` path,
   * because the structured API gives Mailda nothing to store (ADR 33).
   */
  "GET /api/sends/:sendId/submitted": async ({ request, env, clock, params }) => {
    /*
     * One call, and the authorization lives beside the inbound `.eml`'s in `authz-read.ts` (#95).
     *
     * It used to be written out here — a `mayRead` and a §5C 404 — and that is how it came to differ from
     * `authorizeExport`: content access where the inbound path requires `message.export`, so the same
     * person was refused one copy and served the other. Two routes stream a whole RFC 5322 message off
     * this Node and they now share one decision, because the way the divergence survived was that nothing
     * put them next to each other.
     */
    const allowed = await authorizeSendExport(env, clock, request, params.sendId);
    if (!allowed.ok) return allowed.response;
    const row = allowed.row;
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
        "content-disposition": `attachment; filename="${safeFilename(params.sendId, "-submitted.eml")}"`,
      },
    });
  },

  "POST /api/sends/:sendId/cancel": async ({ env, clock, params, who }) => {
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
    ).bind(who.orgId, params.sendId).first<{ mailbox_id: string }>();
    const mayCancel = target !== null
      && await maySend(env, { orgId: who.orgId, userId: who.userId }, target.mailbox_id);
    if (!mayCancel) {
      return Response.json({ cancelled: false, reason: "no such send" }, { status: 409 });
    }

    const outcome = await cancelSend(env, clock, who.orgId, params.sendId, { actorUserId: who.userId });
    return Response.json(outcome, { status: outcome.cancelled ? 200 : 409 });
  },

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
  "POST /api/sends/:sendId/retry": async ({ request, env, clock, params, who }) => {
    const target = await env.CATALOG.prepare(
      "SELECT mailbox_id FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
    ).bind(who.orgId, params.sendId).first<{ mailbox_id: string }>();
    const mayRetry = target !== null
      && await maySend(env, { orgId: who.orgId, userId: who.userId }, target.mailbox_id);
    if (!mayRetry) {
      // The same body an unknown id gets, for `cancel`'s reason.
      return Response.json({ error: "E_NO_MANIFEST", what: "no such send" }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.mode === "retry-effect") {
      return Response.json(await retryEffect(env, clock, who.orgId, who.userId, params.sendId));
    }
    if (body.mode === "resend-may-duplicate") {
      return Response.json(await resendMayDuplicate(env, clock, who.orgId, {
        userId: who.userId,
        acceptDuplicateRisk: body.acceptDuplicateRisk === true,
        reason: String(body.reason ?? ""),
      }, params.sendId));
    }
    return Response.json({
      error: "E_RETRY_MODE_UNKNOWN",
      what: `${JSON.stringify(body.mode ?? null)} is not a retry mode`,
      why: "there are two, because there are two epistemic states: one reuses the original idempotency key "
        + "and provably cannot duplicate, and one mints a new key and might",
      fix: 'send {"mode":"retry-effect"} where GET /api/sends offers it, or '
        + '{"mode":"resend-may-duplicate","acceptDuplicateRisk":true,"reason":"…"} where it offers that',
    }, { status: 422 });
  },

  /**
   * Releasing a send a **rule** held (#60, #81).
   *
   * Distinct from `/release`, which is the Butler gate: that one hands a run's proposed send to a
   * person, this one clears a `policy_hold`. Two acts because they answer to two different authorities and
   * clear two different reasons, and a single route matching on `state` alone would let one walk a message
   * past the other's gate.
   */
  "POST /api/sends/:sendId/release-hold": async ({ env, clock, params, who }) => {
    const outcome = await releasePolicyHold(env, clock, who.orgId, who.userId, params.sendId);
    return Response.json(outcome, { status: outcome.released ? 200 : 409 });
  },

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
  "POST /api/sends/:sendId/release": async ({ env, clock, params, who }) => {
    const outcome = await releaseButlerSend(env, clock, who.orgId, who.userId, params.sendId);
    return Response.json(outcome, { status: outcome.released ? 200 : 409 });
  },

  /**
   * The sending transport's credentials (#86, ADR 33, ADR 22).
   *
   * `GET /api/transport` — which adapter carries this Node's mail, and what it can say about itself
   * `PUT /api/transport` — supply the Cloudflare account id and an Email Sending API token
   *
   * **The token is never returned by anything.** `GET` reports *that* one is configured and when, which is
   * the whole question an operator has; a route that could hand it back would make every administrator a
   * holder of the account's sending authority, which is exactly what wrapping it under the credential KEK
   * is for.
   *
   * Administrator-gated, because supplying this gives the Node the ability to send as the account — the
   * same authority granting mailbox access carries, so the same gate.
   */
  "GET /api/transport": async ({ env, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { restConfigured } = await import("../outbound/rest-transport.ts");
    const chosen = await chooseTransport(env);
    const rest = await restConfigured(env);
    return Response.json({
      transport: {
        adapter: chosen.name,
        capability: await chosen.capability(env),
        /*
         * Both adapters' availability, so the answer to *why is this Node using that one* is on the same
         * screen as the choice. `binding` is a fact about the deployment; `rest` is a fact about D1.
         */
        available: {
          binding: env.EMAIL !== undefined,
          rest: rest === null ? null : { accountId: rest.accountId, configuredAt: rest.at },
        },
      },
    });
  },

  "PUT /api/transport": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const accountId = String(body.accountId ?? "").trim();
    const apiToken = String(body.apiToken ?? "").trim();
    if (accountId === "" || apiToken === "") {
      throw unprocessable("E_TRANSPORT_NEEDS_BOTH", {
        what: `accountId was ${accountId === "" ? "empty" : "given"} and apiToken was `
          + `${apiToken === "" ? "empty" : "given"}`,
        why: "an account id with no token is a transport that would report itself available and refuse "
          + "every send, so the two halves are one configuration and arrive together",
        fix: "put { accountId, apiToken }. The token needs the Email Sending: Edit permission",
      });
    }

    const { wrapCredential } = await import("../auth/kek.ts");
    // Wrapped before the batch is built: `auditedBatch`'s statement builder is synchronous, and the
    // wrap is a Durable Object round trip for the key.
    const wrapped = await wrapCredential(env, apiToken);
    const at = new Date(clock.now()).toISOString();
    await auditedBatch<never>(
      env, clock, who.orgId,
      {
        action: "transport.configured", outcome: "ok", actorUserId: who.userId, subject: accountId,
        /*
         * The account id and who did it — never the token, not even its length. An audit trail that
         * recorded a credential would be a second place it lives, in the one table designed to be read.
         */
        detail: { accountId, adapter: "cloudflare-email-rest" },
      },
      (entry: D1PreparedStatement) => [
        env.CATALOG.prepare(
          `INSERT INTO sending_transport (id, account_id, api_token, configured_by, configured_at)
           VALUES (1,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             account_id = excluded.account_id, api_token = excluded.api_token,
             configured_by = excluded.configured_by, configured_at = excluded.configured_at`,
        ).bind(accountId, wrapped, who.userId, at),
        entry,
      ],
    );
    return Response.json({ configured: { accountId, configuredAt: at } });
  },

  "GET /api/sends": async ({ request, env, clock, who }) => {
    // A thread's outbound half: the sends whose parent is in the conversation named. Same bound as the
    // whole outbox, one more predicate.
    const conversationId = new URL(request.url).searchParams.get("conversation") || null;
    // Subjects are the user plus every team they belong to, which is what `hasRelation` and
    // `listMessages` both do. A relation held through a team is held.
    const subjects = await readableSubjects(env, who);
    const subjectPlaceholders = subjects.map(() => "?").join(", ");
    /*
     * The sponsor term (#109), because `GET /api/sends` is a route an agent may hold. A manifest carries the
     * subject line and every envelope recipient of an outgoing message, so this is content rather than
     * metadata — an unintersected read here is a worse leak than the inbox listing.
     */
    const sponsor = await sponsorTerm(env, who.orgId, who.userId, "t");
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
            SELECT t.object_id FROM relationship_tuples t
             WHERE t.org_id = ? AND t.subject_id IN (${subjectPlaceholders})
               AND t.object_type = 'mailbox' AND t.relation = 'mailbox.content.read'
               ${sponsor.sql}
          )
          ${conversationId === null ? "" : `AND in_reply_to_message_id IN (
            SELECT id FROM messages WHERE org_id = ? AND conversation_id = ?)`}
        ORDER BY sealed_at DESC LIMIT ${SEND_LIST_CAP + 1}`,
    ).bind(who.orgId, who.orgId, ...subjects, ...sponsor.params,
      ...(conversationId === null ? [] : [who.orgId, conversationId])).all<Record<string, unknown>>();

    // Recipients travel with the sends rather than behind a second request per row.
    //
    // The manifest's own `state` is the *last submission's* state, and on its own it cannot express
    // "one bounced and two were accepted" — which is the distinction Layer 2 is judged on. A UI that
    // rendered only the manifest state would show one chip for a mixed outcome, so the data it needs
    // arrives together with it. One query for up to 50 sends, not fifty.
    const { rows: sends, truncated } = capped(rows.results, SEND_LIST_CAP);
    const recipients = sends.length === 0
      ? { results: [] as Array<Record<string, unknown>> }
      : await env.CATALOG.prepare(
          // Ordered the way a person writes an envelope, not the way SQLite sorts strings. `ORDER BY
          // kind` is alphabetical, which put **bcc first and to last** — so a reader met the blind-copy
          // before the actual addressee, and the summary chips inherited that order too.
          `SELECT manifest_id, kind, address, submission_state, delivery_state, bounce_type, last_error
             FROM send_recipients
            WHERE org_id = ? AND manifest_id IN (${sends.map(() => "?").join(", ")})
            ORDER BY manifest_id,
                     CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 WHEN 'bcc' THEN 2 ELSE 3 END,
                     address`,
        ).bind(who.orgId, ...sends.map((r) => r.id)).all<Record<string, unknown>>();

    const byManifest = new Map<string, Array<Record<string, unknown>>>();
    for (const row of recipients.results) {
      const key = String(row.manifest_id);
      byManifest.set(key, [...(byManifest.get(key) ?? []), row]);
    }

    return Response.json({
      truncated,
      sends: sends.map((send) => ({
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
      capability: await (await chooseTransport(env)).capability(env),
    });
  },

  // Releases anything whose hold window has closed. The sweeper alarm does this too; the endpoint
  // exists so an operator does not have to wait for an alarm to see the machinery work.
  "POST /api/sends/dispatch": async ({ env, clock, who }) => {
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
      dispatched: await dispatchDue(env, clock, who.orgId, await chooseTransport(env), 20, dispatchable),
    });
  },
} satisfies Some;

/** Strict base64 to bytes. A body that is not base64 is a caller's mistake and is refused as one. */
function decodeBase64(text: string): Bytes {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw unprocessable("E_ATTACHMENT_NOT_BASE64", {
      what: "an attachment's contentBase64 is not base64",
      why: "the bytes stored and sent must be the bytes the author attached, and a lenient decode would invent them",
      fix: "encode the file's bytes as standard base64 with padding",
    });
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
