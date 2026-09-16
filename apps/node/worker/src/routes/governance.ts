import { streamEvidence } from "../evidence-store.ts";
import { principalFor } from "../authz-read.ts";
import { authorizeExportObject, exportsForReport, requestExport, runExport } from "../exports.ts";
import { isAdmin } from "../access.ts";
import { closeMatter, listMatters, openMatter } from "../matters.ts";
import { grantsForReport, requestSupervisedRead } from "../supervised.ts";
import { holdsForReport, placeHold, requestHoldLift } from "../holds.ts";
import { createPolicyDraft, editPolicyDraft, publishPolicy } from "../policy.ts";
import { decideApproval, pendingApprovals, withdrawApproval } from "../approvals.ts";
import { safeFilename } from "../outbound/headers.ts";
import { unauthenticated, conditionsFrom, stagesFrom } from "./support.ts";
import type { Some } from "../router.ts";

export const governance = {
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
  "GET /api/holds": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ holds: await holdsForReport(env, who.orgId) });
  },

  "POST /api/holds": async ({ request, env, clock }) => {
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
  },

  "POST /api/holds/:holdId/lift": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // An absent reason reaches `requestHoldLift` as the empty string and is refused there with the
    // four-part message, rather than being defaulted to something like "no reason given" — which would be
    // this Node inventing a justification for re-permitting destruction.
    const requested = await requestHoldLift(
      env, clock, who.orgId, who.userId, params.holdId, String(body.reason ?? ""),
    );
    return Response.json({ lift: requested });
  },

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
  "POST /api/matters": async ({ request, env, clock }) => {
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
  },

  "GET /api/matters": async ({ request, env, clock }) => {
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
  },

  "POST /api/matters/:matterId/close": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    return Response.json({
      matter: await closeMatter(env, clock, who.orgId, who.userId, params.matterId),
    });
  },

  "POST /api/supervised": async ({ request, env, clock }) => {
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
  },

  "GET /api/supervised": async ({ request, env, clock }) => {
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
  },

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
  "POST /api/exports": async ({ request, env, clock }) => {
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
  },

  "GET /api/exports": async ({ request, env, clock }) => {
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
  },

  "POST /api/exports/:exportId/run": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    // Only the requester may run their own export — `runExport` enforces it and answers 404 otherwise, for
    // the reason its own comment gives: the approval named a person, and somebody else staging the bytes
    // would put a copy in the trail under a name that never asked for it.
    return Response.json({ run: await runExport(env, clock, who.orgId, who, params.exportId) });
  },

  "GET /api/exports/:exportId/objects/:objectId": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    const allowed = await authorizeExportObject(
      env, who.orgId, who, params.exportId, params.objectId,
    );
    if (!allowed.ok) return allowed.response;
    return new Response(await streamEvidence(env, allowed.blobKey), {
      headers: {
        // The manifest is JSON and every other object is a message. Decided from the name rather than
        // from a column, because the name is what the manifest itself records and a second answer would
        // be a second thing to keep true.
        "content-type": params.objectId === "manifest.json"
          ? "application/json"
          : "message/rfc822",
        // Built rather than interpolated, for `safeFilename`'s reason one route down: a header value
        // assembled from a path segment is where a CR or LF becomes a second header.
        "content-disposition":
          `attachment; filename="${safeFilename(params.objectId.replace(/\.[a-z]+$/, ""),
            params.objectId === "manifest.json" ? ".json" : ".eml")}"`,
      },
    });
  },

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
  "POST /api/policies": async ({ request, env, clock }) => {
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
  },

  /*
   * **PUT, and it was POST until #85's route registry made the mismatch visible.**
   *
   * `src/client/app/api.ts` has always sent PUT here — `act(…, "PUT", …)` — and this guard answered
   * only POST, so every attempt to edit a policy draft from the interface fell through to the 404 at the
   * foot of this handler and told the operator `not_found`. On a governance surface. Since the route
   * shipped.
   *
   * Nothing caught it because `test/policy-routes.test.ts` builds every request with one helper that
   * hard-codes `method: "POST"` — so the suite could not express the verb the UI actually uses, let alone
   * disagree with it. That is the shape #85 exists to close, and the reason a registry is worth more than a
   * reviewer: `packages/contract/src/routes.ts` now types the client's template per method, so the pair
   * cannot diverge again without failing the build.
   *
   * **PUT rather than teaching the client POST**, on two grounds. `/api/butlers/:id/draft` — the same act
   * one layer along — is already PUT, so POST here left the Node holding two verbs for one operation; and
   * replacing a draft wholesale is what PUT means. Nothing that works today breaks, because nothing worked.
   */
  "PUT /api/policies/:policyId/draft": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({
      policy: await editPolicyDraft(env, clock, who.orgId, who.userId, params.policyId, {
        outcome: String(body.outcome ?? ""),
        conditions: conditionsFrom(body.conditions),
        stages: stagesFrom(body.stages),
      }),
    });
  },

  "POST /api/policies/:policyId/publish": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    return Response.json({
      published: await publishPolicy(env, clock, who.orgId, who.userId, params.policyId),
    });
  },

  "GET /api/policies": async ({ request, env, clock }) => {
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
  },

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
  "GET /api/approvals": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    return Response.json({ approvals: await pendingApprovals(env, who.orgId, who.userId) });
  },

  "POST /api/approvals/:approvalId/decide": async ({ request, env, clock, params }) => {
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
      decided: await decideApproval(env, clock, who.orgId, who.userId, params.approvalId, decision),
    });
  },

  "POST /api/approvals/:approvalId/withdraw": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    return Response.json({
      withdrawn: await withdrawApproval(env, clock, who.orgId, who.userId, params.approvalId),
    });
  },
} satisfies Some;
