import { unprocessable } from "../errors.ts";
import { principalFor } from "../authz-read.ts";
import { isAdmin } from "../access.ts";
import { pausesInForce as butlerPausesInForce } from "../butler/pause.ts";
import { resumeButlerPause } from "../butler/pause-acts.ts";
import { recentRuns, runEffects, runRow } from "../butler/record.ts";
import { inspectRun, replayRun } from "../butler/replay.ts";
import { createButlerDraft, editButlerDraft, publishButler, readSourceFormat } from "../butlers.ts";
import { simulateButler } from "../butler/simulate.ts";
import { readOnly } from "../read-only.ts";
import { unauthenticated } from "./support.ts";
import type { Some } from "../router.ts";

export const butlers = {
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
  "GET /api/butler-runs": async ({ request, env, clock, url }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const limit = Number(url.searchParams.get("limit") ?? "25");
    return Response.json({ runs: await recentRuns(env, who.orgId, Number.isFinite(limit) ? limit : 25) });
  },

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
  "POST /api/butlers": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({
      butler: await createButlerDraft(env, clock, who.orgId, who.userId, {
        name: String(body.name ?? ""),
        source: String(body.source ?? ""),
        /*
         * Passed through unnarrowed, deliberately. `readSourceFormat` takes `unknown` and refuses anything
         * that is not a format it parses, so `String(body.sourceFormat ?? "")` here would be the bug: it
         * turns an absent field into the string `""` and a wrong one into a plausible-looking value, and
         * both arrive at the parser as something the caller never wrote.
         */
        sourceFormat: readSourceFormat(body.sourceFormat),
      }),
    });
  },

  "PUT /api/butlers/:butlerId/draft": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({
      butler: await editButlerDraft(env, clock, who.orgId, who.userId, params.butlerId, {
        source: String(body.source ?? ""),
        sourceFormat: readSourceFormat(body.sourceFormat),
      }),
    });
  },

  /**
   * The dry run (#87, §5's fifth charted answer).
   *
   * `POST /api/butlers/:id/simulate` — walk the current program over facts the caller supplies, cause
   * nothing, and report what a live run would have done.
   *
   * **`readOnly(env)` is the whole safety argument, and it is this one expression.** `simulate.ts` takes a
   * `ReadOnlyEnv` throughout, and `ReadOnlyEnv` is not assignable to `Env` — so no function reachable from
   * that call can construct the live effect handle, write a row, or seal a manifest. Not because a check
   * refuses it: because it does not compile. `src/read-only.ts` carries the argument.
   *
   * Admin-gated **here** rather than inside, and that is a departure from the three authoring routes above
   * which check for themselves. The reason is the narrowing: `isAdmin` needs an environment it can read
   * relationship tuples with, and doing it inside would mean either widening `simulate.ts`'s parameter — the
   * one thing this design must not do — or narrowing `isAdmin` for one caller. The gate stays where the
   * writable environment still exists, which is here.
   */
  "POST /api/butlers/:butlerId/simulate": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    // A Butler in another organization and one this person may not see answer identically (§5C).
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const facts = body.facts;
    if (facts === null || typeof facts !== "object" || Array.isArray(facts)) {
      throw unprocessable("E_SIMULATION_NEEDS_FACTS", {
        what: `facts was ${facts === undefined ? "absent" : JSON.stringify(facts)}`,
        why: "a dry run answers \"what would this program do given this\", so it needs the given — and a "
          + "run over no facts would report a walk whose every expression resolved to nothing",
        fix: "post { facts: { … } }. The shape is a delivery's facts: the same object a live run's "
          + "trigger carries, which GET /api/butler-runs shows for any run this Node has performed",
      });
    }
    return Response.json({
      simulation: await simulateButler(readOnly(env), who.orgId, who.userId, params.butlerId, {
        facts: facts as Readonly<Record<string, unknown>>,
        event: typeof body.event === "string" ? body.event : undefined,
        key: typeof body.key === "string" ? body.key : undefined,
      }),
    });
  },

  "POST /api/butlers/:butlerId/publish": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    return Response.json({
      published: await publishButler(env, clock, who.orgId, who.userId, params.butlerId),
    });
  },

  /**
   * Every Butler, with the version that is live and whether a machine has stopped it.
   *
   * The pause is joined in rather than left to a second request, because *"this Butler is published"* and
   * *"this Butler is running"* are different facts and a list that showed only the first would be the
   * enablement pointer #66 rejected — it would read as *deployed and working* over a Butler a breaker
   * stopped. `pausesInForce` is the same function `triggerButlers` consults, so the list and the gate
   * cannot disagree.
   */
  "GET /api/butlers": async ({ request, env, clock }) => {
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
  },

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
  "GET /api/butlers/:butlerId": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const butler = await env.CATALOG.prepare(
      "SELECT id, name, created_at FROM butlers WHERE org_id = ? AND id = ?",
    ).bind(who.orgId, params.butlerId).first<Record<string, unknown>>();
    // A Butler in another organization and one that never existed answer identically (§5C).
    if (butler === null) return Response.json({ error: "not_found" }, { status: 404 });
    const { results } = await env.CATALOG.prepare(
      `SELECT id, version, state, source_format, ast_sha256, source_sha256, created_by, created_at,
              published_by, published_at, superseded_at,
              CASE WHEN state IN ('draft', 'published') THEN source_text ELSE NULL END AS source_text
         FROM butler_versions
        WHERE org_id = ? AND butler_id = ?
        ORDER BY COALESCE(version, 2147483647) DESC, created_at DESC`,
    ).bind(who.orgId, params.butlerId).all<Record<string, unknown>>();
    return Response.json({ butler, versions: results });
  },

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
  "GET /api/butler-pauses": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ pauses: await butlerPausesInForce(env, who.orgId) });
  },

  "POST /api/butler-pauses/:pauseId/resume": async ({ request, env, clock, params }) => {
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
        env, clock, who.orgId, who.userId, params.pauseId, String(body.reason ?? ""),
      ),
    });
  },

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
  "GET /api/butler-runs/:runId/inspect": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const inspected = await inspectRun(env, clock, who, params.runId);
    if (inspected === null) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(inspected);
  },

  "POST /api/butler-runs/:runId/replay": async ({ request, env, clock, params }) => {
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
    return Response.json(await replayRun(env, clock, who.orgId, who.userId, params.runId));
  },

  "GET /api/butler-runs/:runId": async ({ request, env, clock, params }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const run = await runRow(env, who.orgId, params.runId);
    if (run === null) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ run, effects: await runEffects(env, who.orgId, params.runId) });
  },
} satisfies Some;
