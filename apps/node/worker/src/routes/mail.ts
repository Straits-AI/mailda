import { ID_PREFIXES } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { failedBodyIndex, repairBodyIndex } from "../search.ts";
import { getEvidence, streamEvidence } from "../evidence-store.ts";
import { listMessages, authorize, authorizeExport, readableSubjects, readableMailboxes } from "../authz-read.ts";
import { claim, close, mailboxQueues, queueFor, release, steal } from "../cases.ts";
import { assertAdmin } from "../access.ts";
import { notificationsFor } from "../notifications.ts";
import { mergeConversations } from "../merge.ts";
import { setResponseTarget } from "../mailbox-policy.ts";
import { deleteDraft, draftForReply, listDrafts, readDraft, saveDraft } from "../drafts.ts";
import { safeFilename } from "../outbound/headers.ts";
import { addressList, isId, notFound } from "./support.ts";
import type { Some } from "../router.ts";

export const mail = {
  /**
   * Drafts. The composer autosaves here, so this is the one write path a person triggers by *typing*
   * rather than by deciding — which is why nothing about it is audited (see `0012_drafts.sql`) and why
   * the body goes to R2 encrypted rather than into a D1 column.
   */
  "GET /api/drafts": async ({ env, url, who }) => {
    // `?inReplyTo=` answers the composer's real question — "is there already a draft for this reply?" —
    // in one round trip. Without it the client would list every draft and filter, which is a decision
    // about somebody's unfinished work made in a browser.
    const inReplyTo = url.searchParams.get("inReplyTo");
    if (inReplyTo !== null) {
      return Response.json({ draft: await draftForReply(env, who.orgId, who.userId, inReplyTo) });
    }
    return Response.json({ drafts: await listDrafts(env, who.orgId, who.userId) });
  },

  "PUT /api/drafts": async ({ request, env, clock, who }) => {
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
        to: addressList(body.to) ?? [],
        cc: addressList(body.cc),
        bcc: addressList(body.bcc),
        subject: String(body.subject ?? ""),
        body: String(body.body ?? ""),
      },
    );
    return Response.json({ draft });
  },

  "GET /api/drafts/:draftId": async ({ env, params, who }) => {
    const record = await readDraft(env, who.orgId, who.userId, params.draftId);
    // §5C: a draft that never existed and one belonging to somebody else answer identically.
    if (record === null) {
      return Response.json(
        { error: "not_found", message: "No such draft, or you do not have access to it." },
        { status: 404 },
      );
    }
    return Response.json({ draft: record });
  },

  "DELETE /api/drafts/:draftId": async ({ env, clock, params, who }) => {
    // A legal hold refuses this with `E_LEGAL_HOLD` (409) and the central `CallerError` handler renders it.
    // Deliberately not caught here: somebody pressing "discard" is owed the reason, and the alternative —
    // answering `{ deleted: false }` — would say the draft is still there without saying why.
    const deleted = await deleteDraft(env, clock, who.orgId, who.userId, params.draftId);
    return Response.json({ deleted }, { status: deleted ? 200 : 404 });
  },

  /**
   * Layer 3: the queue, the claim, and access administration.
   *
   * `claim` is what the reply button calls (#42) — claiming and opening the composer are one act, because
   * the guarantee lives in the compare-and-swap rather than in a separate gesture.
   */
  /*
   * The **readable** catalogue, which is a different question from the queue rail below it. `mail.read`
   * used to contain that rail — so a read-only agent could open messages and got an empty mailbox list,
   * with no way to discover the ids it was allowed to read.
   */
  "GET /api/mailboxes/readable": async ({ env, who }) => {
    return Response.json({ mailboxes: await readableMailboxes(env, who) });
  },

  "GET /api/mailboxes": async ({ env, who }) => {
    return Response.json({ mailboxes: await mailboxQueues(env, who.orgId, who.userId) });
  },

  /*
   * Quarantine (0056): deliveries held back from every queue because the sender's own domain disowned them.
   * Administrators only, and the list is the only way to a release — there is no delete, because nothing
   * deletes mail on this Node.
   */
  "GET /api/quarantine": async ({ env, who }) => {
    const { listQuarantined } = await import("../quarantine.ts");
    return Response.json({ quarantined: await listQuarantined(env, who.orgId, who.userId) });
  },

  "POST /api/quarantine/:messageId/hold": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { holdDelivery } = await import("../quarantine.ts");
    return Response.json(await holdDelivery(env, clock, who.orgId, who.userId, params.messageId, {
      reason: String(body.reason ?? ""),
      score: typeof body.score === "number" ? body.score : null,
    }));
  },

  "POST /api/quarantine/:messageId/release": async ({ env, clock, params, who }) => {
    const { releaseQuarantine } = await import("../quarantine.ts");
    return Response.json(await releaseQuarantine(env, clock, who.orgId, who.userId, params.messageId));
  },

  "POST /api/mailboxes": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { createMailbox } = await import("../mailboxes.ts");
    return Response.json(await createMailbox(env, clock, who.orgId, who.userId, String(body.name ?? "")));
  },

  "PATCH /api/mailboxes/:mailboxId": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    /*
     * Three settings since 0057, and a PATCH naming a quarantine switch changes only that. The target keeps
     * its older reading — absent and null are the same request, "promise nothing" — because it was the only
     * field for a month and callers send `{}` to clear it; the switch is a boolean and has no such default.
     */
    for (const [field, which] of [["quarantineDmarcFail", "dmarc"], ["quarantineDangerousAttachments", "attachments"]] as const) {
      if (typeof body[field] !== "boolean") continue;
      const { setQuarantineSwitch } = await import("../mailbox-policy.ts");
      return Response.json(
        await setQuarantineSwitch(env, clock, who.orgId, who.userId, params.mailboxId, which, body[field]),
      );
    }
    if ("attachmentMaxBytes" in body || "attachmentAllowedTypes" in body) {
      const { setAttachmentLimits } = await import("../mailbox-policy.ts");
      return Response.json(await setAttachmentLimits(env, clock, who.orgId, who.userId, params.mailboxId, {
        ...("attachmentMaxBytes" in body
          ? { maxBytes: body.attachmentMaxBytes === null ? null : Number(body.attachmentMaxBytes) } : {}),
        ...("attachmentAllowedTypes" in body
          ? { allowedTypes: body.attachmentAllowedTypes === null ? null
            : Array.isArray(body.attachmentAllowedTypes) ? body.attachmentAllowedTypes.map(String) : [] }
          : {}),
      }));
    }
    const raw = body.firstResponseMinutes;
    const minutes = raw === null || raw === undefined ? null : Number(raw);
    return Response.json(
      await setResponseTarget(env, clock, who.orgId, who.userId, params.mailboxId, minutes),
    );
  },

  /*
   * The mailbox is a **path segment**. It was `?mailbox=`, and the route registry never declared it — so the
   * generated client and the MCP tool had no way to send it and always met the refusal below, which is now
   * unreachable and gone. `queue.read` was a capability an agent could be granted and could not use.
   *
   * `routes.ts` already carried the rule: *"a parameter the route cannot answer without is a path segment
   * wearing a disguise"*. A queue belongs to one mailbox, so this route could never answer without it.
   */
  "GET /api/mailboxes/:mailboxId/cases": async ({ env, clock, params, who }) => {
    if (!isId(ID_PREFIXES.mailbox, params.mailboxId)) return notFound();
    // Empty rather than forbidden for a mailbox this caller cannot see: §5C keeps an absent thing and an
    // invisible one alike, and a queue is a list, which Blueprint:358 gates before returning counts.
    return Response.json({ cases: await queueFor(env, clock, who.orgId, who.userId, params.mailboxId) });
  },

  "POST /api/cases/:caseId/:action": async ({ env, clock, params, who }) => {
    const { caseId, action } = params;
    if (!["claim", "steal", "release", "close"].includes(action)) return notFound();

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
  },

  "PUT /api/cases/:caseId/assignee": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { assign } = await import("../cases.ts");
    // By id, or by the address a colleague signs in with: the directory is an administrator's read, and a
    // person handing over a case knows their colleague's address, not their `usr_` id. An address that is
    // nobody here answers as one who cannot send — the same word, so the route is not a membership oracle.
    let toUserId = String(body.userId ?? "");
    if (toUserId === "" && typeof body.email === "string") {
      const found = await env.CATALOG.prepare("SELECT id FROM users WHERE org_id = ? AND lower(email) = lower(?) LIMIT 1")
        .bind(who.orgId, body.email.trim()).first<{ id: string }>();
      toUserId = found?.id ?? "usr_nobody";
    }
    const outcome = await assign(env, clock, who.orgId, who.userId, params.caseId, toUserId);
    if (outcome.kind === "claimed") return Response.json({ claimed: true, case: outcome.case });
    if (outcome.kind === "not_a_colleague") {
      return Response.json({
        claimed: false, error: "not_a_colleague",
        message: "That person cannot send from this mailbox, so the case would sit in nobody's queue. Grant them send.propose first.",
      }, { status: 422 });
    }
    if (outcome.kind === "closed") return Response.json({ claimed: false, error: "closed", message: "This case is closed." }, { status: 409 });
    if (outcome.kind === "held") {
      return Response.json({
        claimed: false, error: "held", heldBy: outcome.by, heldSince: outcome.since,
        message: `Held by ${outcome.by} since ${outcome.since}; it changed hands while you looked.`,
      }, { status: 409 });
    }
    return Response.json({ claimed: false, error: "not_found", message: "No such case, or you do not have access to it." }, { status: 404 });
  },

  "PUT /api/messages/:messageId/read": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { setRead } = await import("../reads.ts");
    return Response.json(await setRead(env, clock, who.orgId, who.userId, params.messageId, body.read !== false));
  },

  "PUT /api/messages/:messageId/labels": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
    const { setLabels } = await import("../labels.ts");
    return Response.json(await setLabels(env, clock, who.orgId, who.userId, params.messageId, {
      add: strings(body.add), remove: strings(body.remove),
    }));
  },

  "POST /api/conversations/merge": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const outcome = await mergeConversations(
      env, clock, who.orgId, who.userId,
      String(body.from ?? ""), String(body.into ?? ""),
    );
    // A refusal is 409, not 400: the request was well-formed and the *state* did not permit it, which is
    // the distinction `errors.ts` already draws. The reason names what to resolve.
    return Response.json(outcome, { status: outcome.merged ? 200 : 409 });
  },

  /*
   * Listing and repairing what the body index failed on (0044).
   *
   * ## Why this is a route rather than a documented SQL statement
   *
   * The receipt for #107 L2 said, in as many words, that repairing a message meant clearing
   * `body_indexed_at` by hand and that no route exposed it. An operator whose search cannot find a message
   * they know exists was being handed a `wrangler d1 execute` — which is not a repair path, it is an
   * invitation to write an `UPDATE` with no `WHERE` at three in the morning.
   *
   * ## GET lists with reasons; POST re-queues by id
   *
   * Two shapes rather than a single "repair everything", because the reasons matter. Some failures are
   * deterministic — a body no parser will ever read — and repairing those spends attempts on messages that
   * cannot succeed. So the list comes back with the error against each id, and the caller decides.
   *
   * Administrator-gated: it re-queues work for the whole organization's mail, and the ids it takes name
   * messages the caller may not otherwise be able to read. The `org_id` in `repairBodyIndex`'s predicate is
   * what keeps an id from another organization inert rather than merely unlikely.
   */
  "GET /api/search/failed": async ({ env, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    return Response.json({ failed: await failedBodyIndex(env, who.orgId, BUDGETS["messages.page_size"]) });
  },

  "POST /api/search/repair": async ({ request, env, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const body = (await request.json().catch(() => ({}))) as { messageIds?: string[] };
    const ids = (body.messageIds ?? []).slice(0, BUDGETS["messages.page_size"]);
    if (ids.length === 0) {
      return Response.json(
        {
          error: "unprocessable",
          what: "no message ids to repair",
          why: "repair is per message rather than a sweep. A sweep would re-queue the messages that are "
            + "deterministically unparseable along with the ones worth retrying, and spend the backfill's "
            + "budget on work that cannot succeed.",
          fix: `GET /api/search/failed lists them with the reason each failed; pass the ids worth retrying`,
        },
        { status: 422 },
      );
    }
    /*
     * Two statements in one batch: the index rows go and the state resets together. A repair that deleted
     * the rows and then failed to reset the state would leave messages unsearchable with nothing queued to
     * put them back.
     */
    const results = await env.CATALOG.batch(repairBodyIndex(env, who.orgId, ids));
    const outcome = results[1]!;
    return Response.json({
      requeued: outcome.meta.changes ?? 0,
      message: "Queued for the next backfill pass, which runs every minute and settles 25 messages. "
        + "Attempt counts were reset, so each gets a full set of retries again.",
    });
  },

  "GET /api/messages": async ({ request, env, clock }) => {
    return listMessages(env, clock, request);
  },

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
  "GET /api/notifications": async ({ env, who }) => {
    // Subjects are the person plus every team they belong to, which is what every other read here does. A
    // mailbox read through a team is a mailbox whose notices reach that team's members.
    const subjects = await readableSubjects(env, who);
    return Response.json({ notifications: await notificationsFor(env, who, subjects) });
  },

  /**
   * A message body, extracted and sanitised (ADR 37).
   *
   * The HTML returned here is for a **sandboxed iframe** and nothing else. The client must render it
   * with no `allow-scripts` and no `allow-same-origin`, because that — not this sanitiser — is the
   * trust boundary. Sanitising reduces what the browser's parser is handed and withholds remote
   * content; it is not a claim that the output is inert.
   */
  "GET /api/messages/:receiptId/body": async ({ request, env, clock, params }) => {
    // `supervised.opened` — §7's *result opened*. The body is one message's content, which is what
    // distinguishes it from the raw read below.
    const allowed = await authorize(env, clock, request, params.receiptId, "supervised.opened");
    if (!allowed.ok) return allowed.response;
    const { renderBody } = await import("../render/body.ts");
    // The organization's own domains, for the lookalike verdict: every domain an address is routed under.
    const own = await env.CATALOG.prepare(
      "SELECT DISTINCT lower(substr(address, instr(address, '@') + 1)) AS domain FROM addresses WHERE org_id = ?",
    ).bind(allowed.orgId).all<{ domain: string }>();
    const raw = await getEvidence(env, allowed.blobKey);
    // Who the message was addressed to, from the header block `mime.ts` owns (ADR 38: the body parser
    // returns no headers). What a reply-all is built from, and what the pane shows under "to".
    const { addressesOf, headerBlock, headerFields } = await import("../mime.ts");
    const fields = headerFields(headerBlock(raw));
    const recipients = {
      to: addressesOf(fields.get("to")?.join(", ") ?? ""),
      cc: addressesOf(fields.get("cc")?.join(", ") ?? ""),
      replyTo: addressesOf(fields.get("reply-to")?.join(", ") ?? "")[0] ?? null,
    };
    return Response.json({ ...await renderBody(raw, own.results.map((row) => row.domain)), recipients });
  },

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
  /**
   * One attachment's bytes (17 September 2026), by ordinal in the order the body route lists them — the
   * same parse, so the numbers agree. A copy leaving the Node, so `authorizeExport` and its `message.exported`
   * entry, as `/raw`. The part's own media type goes out only if it is a token/token; the name through
   * `safeFilename`; a program is served as octet-stream whatever it claimed, so a browser saves rather than
   * runs it — the reader was told what it was in the pane.
   */
  "GET /api/messages/:receiptId/attachments/:ordinal": async ({ request, env, clock, params }) => {
    const ordinal = Number(params.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 0) return notFound();
    // Read first, export second: the part has to exist before `message.exported` is recorded, or a 404 would
    // leave an entry saying a copy left when none did. The read check is the body route's own.
    const readable = await authorize(env, clock, request, params.receiptId, "supervised.opened");
    if (!readable.ok) return readable.response;
    const { default: PostalMime } = await import("postal-mime");
    const parsed = await PostalMime.parse(await getEvidence(env, readable.blobKey));
    const part = parsed.attachments[ordinal];
    if (part === undefined) return notFound();
    const allowed = await authorizeExport(env, clock, request, params.receiptId);
    if (!allowed.ok) return allowed.response;
    const { classifyAttachment, DANGEROUS } = await import("../attachments.ts");
    const bytes = typeof part.content === "string" ? new TextEncoder().encode(part.content) : new Uint8Array(part.content);
    const verdict = classifyAttachment(part.filename, bytes.subarray(0, 8));
    const mediaType = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/.test(part.mimeType) && !DANGEROUS.has(verdict)
      ? part.mimeType.toLowerCase() : "application/octet-stream";
    const name = part.filename ?? `part-${ordinal}`;
    const dot = name.lastIndexOf(".");
    const filename = safeFilename(dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot).replace(/[^A-Za-z0-9.]/g, "").slice(0, 11) : "");
    return new Response(bytes, {
      headers: {
        "content-type": mediaType,
        "content-disposition": `attachment; filename="${filename}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  },

  "GET /api/messages/:receiptId/raw": async ({ request, env, clock, params }) => {
    const allowed = await authorizeExport(env, clock, request, params.receiptId);
    if (!allowed.ok) return allowed.response;
    return new Response(await streamEvidence(env, allowed.blobKey), {
      headers: {
        "content-type": "message/rfc822",
        // Built rather than interpolated (see headers.ts `safeFilename`). Found by audit rather
        // than by review, and not exploitable today — `authorize()` proves the id exists in D1 and a
        // URL pathname cannot carry a raw CR or LF — but "not reachable" was a property of two other
        // functions rather than of this line.
        "content-disposition": `attachment; filename="${safeFilename(params.receiptId, ".eml")}"`,
      },
    });
  },
} satisfies Some;
