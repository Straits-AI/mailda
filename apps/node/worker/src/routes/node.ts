import { audit, verifyChain } from "../audit.ts";
import { verifyEvidence } from "../evidence-audit.ts";
import { inventoryPage } from "../evidence-inventory.ts";
import { claimNode } from "../claim.ts";
import { acknowledgeKeyConflict, conflictNotice, confirmRecoveryCodes, mintRecoveryCodes, redeemForVault } from "../recovery.ts";
import { migrate } from "../migrate.ts";
import { principalFor } from "../authz-read.ts";
import { assertAdmin, isAdmin } from "../access.ts";
import { capped } from "../list-cap.ts";
import { authenticationIsImpossible, authenticationProbe, formatReport, runDoctor, withoutDataFindings } from "../doctor.ts";
import { formatReconcile, reconcileEvidence } from "../reconcile.ts";
import { resealBatch } from "../reseal.ts";
import { sessionResponse, unauthenticated, organizationId, armSweeper, claimMessage } from "./support.ts";
import { page } from "../ui.ts";
import type { Some } from "../router.ts";

/** The audit trail and the log each show this many entries, newest first, and say when older ones exist. */
const AUDIT_LIST_CAP = 200;
const LOG_LIST_CAP = 200;

export const node = {
  /**
   * Applies any missing schema. Idempotent, and the only route that works on a Node with none.
   *
   * Unauthenticated on purpose, and the reasoning is the same one `/api/doctor` already uses: on a
   * freshly installed Node authentication is *impossible* — the tables it needs do not exist — so a
   * gate here would be one no caller could satisfy. What it can do is bounded to applying this
   * Node's own bundled migrations, which is idempotent and grants a caller nothing: an attacker who
   * migrates somebody's Node has done them a favour. Once the schema is current it is a no-op.
   */
  "POST /api/prepare": async ({ request, env, clock }) => {
    /*
     * Open while the Node is unclaimed — it is how a fresh install gets its schema — and an administrator's
     * act once it is claimed: a public route that runs the migrator and lists applied migrations is a
     * schema-version oracle and a free D1 round trip for any stranger (the 17 September audit).
     */
    const claimed = await env.CATALOG.prepare("SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1")
      .first<{ org_id: string }>().catch(() => null);
    if (claimed !== null) {
      const who = await principalFor(env, clock, request);
      if (who === null || !(await isAdmin(env, who.orgId, who.userId))) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
    }
    const outcome = await migrate(env);
    return Response.json({
      ...outcome,
      message: outcome.alreadyCurrent
        ? "The schema was already current. Nothing changed."
        : `Applied ${outcome.applied.length} migration(s). This Node can now accept mail once claimed.`,
    });
  },

  "GET /health": async ({ env, clock }) => {
    // A health endpoint that throws when the Node is unhealthy is a health endpoint that reports
    // nothing. On a fresh install these tables do not exist yet, and 500 with an opaque body is the
    // least useful answer available — so the state is named, with the command that resolves it.
    /*
     * **The failure is kept, not discarded** (#149), because two states reached this branch and only one
     * of them had the fix that was printed.
     *
     * `.catch(() => undefined)` collapsed "the tables are not there yet" together with "the database is
     * not there at all". Measured: a Node whose D1 had been deleted answered *"This Node has no schema"*
     * and named `wrangler d1 migrations apply CATALOG --remote` — which resolves `CATALOG` **by name**,
     * found a live database, applied all 51 migrations, and changed nothing the Worker reads, because the
     * binding is linked server-side to the dead id. The operator runs the fix, sees fifty-one green ticks,
     * reloads, and gets the same sentence. There is no thread to pull.
     *
     * D1 answers a missing database with an API-level failure rather than an empty result, so the words in
     * the error are what tell them apart. Matched on D1's own vocabulary rather than on a status code: a
     * binding to a deleted database and a table that does not exist both surface as a query failure.
     */
    const probe = await env.CATALOG.prepare(
      "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
    ).first<{ org_id: string }>().then(
      (row) => ({ row, error: null as string | null }),
      (error: unknown) => ({
        row: undefined,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const claimed = probe.row;
    if (claimed === undefined) {
      /*
       * "no such table" is a schema that has not been applied. Anything else from a query this simple —
       * and in particular D1 reporting that the database itself could not be found — is not, and must not
       * be answered with a command that will report success.
       */
      const noSchema = probe.error === null || /no such table/i.test(probe.error);
      return Response.json({
        node: "mailda",
        healthy: false,
        reason: noSchema
          ? "This Node has no schema, so it cannot accept mail."
          : "This Node cannot reach its catalog database, so it cannot accept mail. This is not a "
            + "missing schema: the CATALOG binding does not resolve to a database this Worker can query.",
        fix: noSchema
          ? "POST /api/prepare to apply the schema, or run `wrangler d1 migrations apply CATALOG --remote`"
          : "do NOT run `migrations apply` — it resolves CATALOG by name and will report success against a "
            + "database this Worker does not read. A deleted D1 is not re-provisioned by a deploy either, "
            + "because the binding is linked server-side. See docs/disaster-recovery.md, which deletes the "
            + "Worker and redeploys, and note the queue consumer must be removed first.",
        ...(noSchema ? {} : { detail: probe.error }),
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
  },

  /**
   * `doctor`. Open while unclaimed — no organization, no users, no mail, and this is exactly when
   * an operator needs it. Authenticated once claimed, because the report names tables, bindings,
   * receipt ids and counts, and a diagnostic is the obvious place to leak what §5C forbids
   * leaking. `/health` remains the unauthenticated surface and remains deliberately dull.
   *
   * `?format=text` for a CLI and for a log line; JSON otherwise.
   */
  "GET /api/doctor": async ({ request, env, clock, url }) => {
    const orgId = await organizationId(env);
    const who = await principalFor(env, clock, request);

    /*
     * ## The decision is made before the diagnostic runs
     *
     * This ran `runDoctor` first and used the result to decide whether to answer 401 — so every anonymous
     * request to a healthy claimed Node paid for a full organization-wide sweep of D1, R2 and the vault and
     * received nothing for it. CI proves that sweep is bounded; bounded is not free, and it is not
     * authorized. An expensive diagnostic anybody can trigger without a credential is an availability and
     * billing surface whatever its ceiling.
     *
     * `authenticationProbe` asks the one question the 401 turns on — can this Node authenticate anybody —
     * with the two checks that answer it.
     *
     * **The ordering is not observable from outside**, and that is said here rather than left for somebody
     * to assume a test covers: `runDoctor` catches per check, so a handler that swept first and refused
     * afterwards answers 401 as well. What `test/operator-routes.test.ts` can assert is that the probe is
     * two findings against the diagnostic's dozens — the substance of the cost, if not the ordering.
     */
    if (orgId !== null && who === null) {
      const probe = await authenticationProbe(env, clock);
      if (!authenticationIsImpossible({ findings: probe })) return unauthenticated();
    }

    /*
     * ## And who sees what, which was "anybody signed in"
     *
     * `discloses: "data"` marks the findings that name holds, matters, mailboxes, send manifests, agent
     * names, Butler triggers and domain pauses — the shape of the organization's work. That classification
     * decided what a locked-out operator saw and nothing else, so an ordinary member reading `doctor` got
     * the whole organization's condition, and `health.read` handed an agent the same.
     *
     * The reduced report is the default now and the full one is an administrator's. Which is also what
     * makes the locked-out case coherent rather than an exception: the anonymous reduced report and the
     * ordinary member's are the same report, for the same reason.
     */
    const full = await runDoctor(env, clock);
    const wholeOrganization = who !== null && await isAdmin(env, who.orgId, who.userId);
    /*
     * Why it was reduced, not only that it was. One sentence covered all three situations and was true of
     * one: a signed-in ordinary member was told this Node cannot authenticate anyone, which is the least
     * useful thing to read during the incident they opened `doctor` to understand.
     */
    const report = wholeOrganization ? full : withoutDataFindings(
      full,
      who !== null ? "not_an_administrator" : orgId === null ? "unclaimed" : "locked_out",
    );
    // A refusing verdict is a 503: the Node is telling a load balancer and a human the same
    // thing, rather than answering 200 with bad news in the body.
    const status = report.verdict === "refuse" ? 503 : 200;

    return url.searchParams.get("format") === "text"
      ? new Response(formatReport(report) + "\n", {
          status, headers: { "content-type": "text/plain; charset=utf-8" },
        })
      : Response.json(report, { status });
  },

  /**
   * Maintenance. Authenticated always — these read and delete an organization's evidence, so unlike
   * `doctor` there is no state in which an anonymous caller should reach them.
   *
   * Both are **bounded and resumable** rather than long-running: each call does one batch and
   * reports what remains, because a Worker invocation cannot re-seal ~8.5M messages and an
   * operation that pretends otherwise fails silently at scale (receipt: evidence-lifecycle.md).
   */
  "POST /api/maintenance/reseal": async ({ env, clock, who }) => {
    /*
     * `org.admin`, and it was **signed in** — which is not the same thing and was never meant to be. This
     * re-wraps every credential in the organization under a fresh key: organization-wide cryptographic
     * maintenance, startable by anybody with a session.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const outcome = await resealBatch(env, clock, who.orgId);
    // 200 even with failures: the batch itself succeeded, and each failure is a named receipt the
    // caller has to act on rather than a request to retry.
    return Response.json(outcome);
  },

  "POST /api/maintenance/reconcile": async ({ env, clock, url, who }) => {
    /*
     * The sharpest of the five. With `collect=1` this is the **only call in the product that destroys
     * content bytes** — `content-deletion-world.test.ts` says so on the `EVIDENCE.delete` it guards — and it
     * asked for nothing but a session. Every safeguard around that delete was doing its work behind a door
     * any member of the organization could open.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const collect = url.searchParams.get("collect") === "1";
    const report = await reconcileEvidence(env, clock, who.orgId, { collect });
    return url.searchParams.get("format") === "text"
      ? new Response(formatReconcile(report) + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
      : Response.json(report);
  },

  "POST /api/claim": async ({ request, env, clock }) => {
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
    /*
     * The ten recovery codes travel in the claim response and **nowhere else, ever** (#92, ADR 29). This
     * Node keeps a hash to recognise one and an escrow only the code itself opens, so there is no route
     * that can produce them a second time — which is the property that makes the escrow worth having and
     * the reason the interface has to show them at this moment.
     */
    return sessionResponse(
      {
        claimed: true,
        organizationId: outcome.orgId,
        email: (body.email ?? "").toLowerCase(),
        recoveryCodes: outcome.recoveryCodes,
      },
      outcome.session!,
    );
  },

  /**
   * Restores the vault from one of ADR 29's codes (#92).
   *
   * **Unauthenticated, and that is the decision rather than an oversight.** The state this exists for is a
   * Node whose Durable Object storage is gone, where `credential` keys are unopenable — and session
   * signing keys are wrapped under exactly those. So requiring a session would make the recovery path
   * reachable only from the state that does not need it. The code is the credential, which is what a
   * recovery code is for.
   *
   * What that costs is bounded on purpose: redemption restores **keys already escrowed by this Node**,
   * issues no session, grants nothing, and reads no mail. Somebody holding a code can put a vault back to
   * a state it was already in. They cannot use it to become anybody.
   */
  "POST /api/recovery/redeem": async ({ request, env, clock }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    const claimed = await env.CATALOG.prepare(
      "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
    ).first<{ org_id: string }>();
    if (claimed?.org_id == null) {
      return Response.json({ error: "not_claimed" }, { status: 409 });
    }
    const outcome = await redeemForVault(env, clock, claimed.org_id, body.code ?? "");
    /*
     * The notice travels **in the payload** (#138), for the reason the mint's does: a caller that reads only
     * the numbers has no way to know a single-use code is gone and the mail is still unreadable. #92's drill
     * answered here with 200, both generations collided, and every layer above called it a restore.
     *
     * Still a 200. Nothing broke and nothing was lost, and the settlement records `ok` for that reason — the
     * change is that the answer now says what happened rather than leaving it to be inferred from two arrays.
     */
    const notice = conflictNotice(outcome.conflicted, outcome.restored);
    /*
     * `adopted` is dropped when empty rather than sent as two empty arrays, so its presence is the signal
     * that something was displaced — the same rule `notice` follows one line down.
     */
    const displaced = outcome.adopted.content.length + outcome.adopted.credential.length;
    const answer = {
      restored: outcome.restored,
      conflicted: outcome.conflicted,
      ...(displaced === 0 ? {} : { adopted: outcome.adopted }),
      ...(notice === null ? {} : { notice }),
    };
    return Response.json(answer);
  },

  /*
   * Minting a replacement set of recovery codes, and confirming one was received (audit, 0042/0043).
   *
   * ## Why these exist as routes at all
   *
   * `mintRecoveryCodes` has always been callable again — it replaces the set atomically and re-escrows
   * every generation the vault now holds — and it was reachable from **exactly one place**: the initial
   * claim. So `doctor` could tell an operator to "mint a fresh set" with no supported way to do it, which
   * is a refusal that names no door. Migration 0042 made that acute by marking every pre-audit set as
   * carrying 80 bits rather than 128.
   *
   * ## Administrator-gated, unlike redeem
   *
   * `/api/recovery/redeem` above is deliberately unauthenticated, because the state it exists for has no
   * verifiable session keys. These two are the opposite case: the Node is working, somebody is signed in,
   * and minting replaces the only artifact that can recover the vault. An unauthenticated mint would let
   * anybody who could reach the Node invalidate its recovery codes — a denial of recovery, silently, with
   * the plaintext going to whoever asked.
   *
   * ## The plaintext is in the response and nowhere else
   *
   * Ten codes, once. Nothing stores them and nothing can produce them again, which is the property that
   * makes the escrow worth having and also the reason `confirm` exists: a lost response leaves this Node
   * looking exactly as it would if they had been written down.
   */
  "POST /api/recovery-codes/rotate": async ({ env, clock, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const minted = await mintRecoveryCodes(env, clock, who.orgId, {
      // Audit P1-2: rotating recovery codes is an administrator's act and the trail recorded it as the
      // Node's. `delegatorUserId` carries through so an agent rotating them names the sponsor too.
      actorUserId: who.userId,
      delegatorUserId: who.delegatorUserId,
    });
    return Response.json({
      codes: minted.codes,
      escrowed: minted.escrowedGenerations,
      // Said in the response rather than only in the docs, because this is the one moment the plaintext
      // exists and the client is what an operator is looking at.
      set: minted.setId,
      notice: "These ten codes are shown once and cannot be shown again. Store them, then confirm one so "
        + "this Node knows you have them. Until you do, `doctor` reports the set unconfirmed and the "
        + "previous sheet keeps working — confirming this one retires it.",
    });
  },

  /**
   * Recording that a permanent key collision has been assessed (P2-2).
   *
   * `doctor` scans every completed restore and stays `degraded` while any of them collided with a live key,
   * for a good reason: nothing repairs a collision, so nothing should clear the finding. But nothing could
   * discharge it either, and a permanent alarm is one an operator learns to scroll past — after which the
   * next real `degraded` reads as the same old noise.
   *
   * This changes what the finding *decides*, never what it says. The loss stays in the report, `ok` stays
   * false, and the severity drops to `report` once somebody has established what was lost.
   */
  "POST /api/recovery/conflicts/:restoreId/acknowledge": async ({ request, env, clock, params, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const recorded = await acknowledgeKeyConflict(env, clock, who.orgId, who.userId, {
      restoreId: params.restoreId,
      // Refused in the domain when blank rather than defaulted here: an acknowledgement this Node filled in
      // on somebody's behalf would be a conclusion nobody reached.
      scope: String(body.scope ?? ""),
      conclusion: String(body.conclusion ?? ""),
    });
    return Response.json({
      acknowledged: {
        restoreId: params.restoreId,
        generations: recorded.generations,
        acknowledgedAt: recorded.acknowledgedAt,
      },
    });
  },

  "POST /api/recovery-codes/confirm": async ({ request, env, clock, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    const outcome = await confirmRecoveryCodes(env, clock, who.orgId, body.code ?? "", {
      actorUserId: who.userId,
      delegatorUserId: who.delegatorUserId,
    });
    return Response.json({
      ...outcome,
      /*
       * The count is the number of rows marked, which is the whole set — confirmation is per set, because
       * one code proven is proof the sheet arrived and typing ten is 260 characters for a checkbox.
       *
       * `alreadyConfirmed` is its own message rather than a count of zero. A genuine code from the set that
       * is already active is neither a success to celebrate nor a failure to chase, and the difference an
       * operator needs to know is whether the *other* sheet is now dead.
       */
      message: outcome.alreadyConfirmed
        ? "That code is from the set already confirmed for this Node. Nothing changed, and any newer "
          + "unconfirmed sheet is still waiting to be confirmed."
        : `Confirmed. ${outcome.confirmed} code(s) marked as held; none were spent. Any previous sheet is `
          + "now retired and will no longer open this vault.",
    });
  },

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
  "GET /api/audit": async ({ env, url, who }) => {
    /*
     * `org.admin`. The trail is **wider than any mailbox grant** — actors and subjects across the whole
     * organization, access-grant history, agent sponsorship, matter and supervised-access events — and this
     * file already said so while checking only for a session. A statement in a comment is not a check.
     *
     * A dedicated `audit.read` relation would be the better long-run answer, so somebody can read the trail
     * without administering the organization. It does not exist, and `org.admin` is the narrower of the two
     * options that do.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const action = url.searchParams.get("action");
    const rows = await env.CATALOG.prepare(
      /*
       * `delegator_user_id` is selected, and its absence was the second half of audit P1-1. The column was
       * written, hashed into the chain and **read by nobody** — so the trail knew which person was
       * accountable for a machine's act and no reader could ask it. A field inside the hash that no surface
       * exposes is worse than a missing one: it looks like the question has been answered.
       */
      `SELECT id, seq, at, actor_user_id, actor_kind, delegator_user_id, action, subject, outcome, detail,
              hash
         FROM audit_entries
        WHERE org_id = ?${action === null ? "" : " AND action = ?"}
        ORDER BY seq DESC LIMIT ${AUDIT_LIST_CAP + 1}`,
    )
      .bind(...(action === null ? [who.orgId] : [who.orgId, action]))
      .all();
    const { rows: entries, truncated } = capped(rows.results, AUDIT_LIST_CAP);
    return Response.json({ entries, truncated });
  },

  // Verification is the point of a hash chain: a log an administrator has to trust is not evidence.
  "POST /api/audit/verify": async ({ env, url, who }) => {
    // The same visibility as reading it: verification reports where a chain broke, which is a fact about
    // the trail somebody who may not read the trail has no business learning.
    await assertAdmin(env, who.orgId, who.userId);
    const from = Number(url.searchParams.get("from") ?? "1");
    return Response.json(await verifyChain(env, who.orgId, Number.isFinite(from) ? from : 1));
  },

  /*
   * Does the evidence still say what ingress recorded it saying? (#92)
   *
   * The step #92 calls the one that makes the rest true — *"prove a sampled set of raw messages decrypt and
   * hash-verify"* — and it applies to the live Node as much as to a restored copy. `doctor` sends one HEAD
   * at the bucket, which answers whether R2 is reachable and nothing about what is in it.
   *
   * Audited as `standalone`, and the classification is argued in `audit.ts` rather than picked. It opens
   * every object in its batch, which looks like the broadest content read the Node performs — but the
   * plaintext is hashed inside the isolate and discarded, and what reaches the caller is a count, a cursor,
   * and for a failed message its receipt id and which of the three ways it failed. Nothing from which a
   * message could be reconstructed, so the disclosure contract would guard against something that does not
   * happen here while making a diagnostic fail exactly when it is needed.
   *
   * The subject is the cursor, never a message id: the entry records the span that was swept, and the
   * faults stay in the response, because a fault names a message and the trail is read by people who are
   * not entitled to know which messages exist.
   */
  "POST /api/evidence/verify": async ({ env, clock, url, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const after = url.searchParams.get("after");
    const verdict = await verifyEvidence(env, who.orgId, after === null || after === "" ? null : after);
    await audit(env, clock, who.orgId, {
      action: "evidence.verified",
      outcome: verdict.intact ? "ok" : "refused",
      actorUserId: who.userId,
      subject: verdict.after ?? "beginning",
      detail: {
        checked: verdict.checked,
        faults: verdict.faults.length,
        bytesRead: verdict.bytesRead,
        resumeAfter: verdict.resumeAfter,
      },
    });
    return Response.json(verdict);
  },

  /*
   * The bucket's inventory (#92). A read, so no audit entry: it discloses no content and writes nothing,
   * and `GET /api/audit` is the precedent — reading is gated, not recorded.
   *
   * Paged by an opaque cursor that walks all four prefixes the Worker writes. The page bound comes from the
   * reconciler's measured figure rather than from the query string, so a caller cannot ask for a page that
   * will not fit in an invocation.
   */
  "GET /api/evidence/inventory": async ({ env, url, who }) => {
    await assertAdmin(env, who.orgId, who.userId);
    const after = url.searchParams.get("after");
    return Response.json(await inventoryPage(env, who.orgId, after === "" ? null : after));
  },

  "GET /api/logs": async ({ env, url, who }) => {
    /*
     * `org.admin`. Operational logs carry error detail and request ids from across the organization — the
     * shape of what other people are doing, which is not a mailbox grant and was not gated as anything.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const level = url.searchParams.get("level");
    const rows = await env.CATALOG.prepare(
      `SELECT id, at, level, event, message, detail, request_id FROM log_entries
        ${level === null ? "" : "WHERE level = ?"}
        ORDER BY at DESC LIMIT ${LOG_LIST_CAP + 1}`,
    )
      .bind(...(level === null ? [] : [level]))
      .all();
    const counts = await env.CATALOG.prepare(
      "SELECT level, COUNT(*) AS n FROM log_entries GROUP BY level",
    ).all<{ level: string; n: number }>();
    const { rows: entries, truncated } = capped(rows.results, LOG_LIST_CAP);
    return Response.json({ entries, truncated, counts: counts.results });
  },

  /*
   * The interface shell. Every route the application owns returns the same page (`isAppRoute`, served from
   * `index.ts`), because the shell routes on the client and a bookmarked `/outbox` must not 404.
   */
  "GET /index.html": async ({ env, ctx }) => {
    ctx.waitUntil(armSweeper(env));
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
} satisfies Some;
