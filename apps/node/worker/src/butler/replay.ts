import { BUDGETS } from "@mailda/budgets";
import { checkButler, describeFindings } from "@mailda/butler-ast";
import type { Ctx } from "@mailda/runtime";

import { auditedBatch, recordDisclosure } from "../audit.ts";
import { mayReadMetadata, type Principal } from "../authz-read.ts";
import { conflict, notFound } from "../errors.ts";
import { retryOffer, type RetryOffer } from "../outbound/retry.ts";
import { supervisedActEvent } from "../supervised.ts";
import { describePause, pausedFrom, PAUSE_COLUMNS_FOR_RUN } from "./pause.ts";
import { redactFacts } from "./trigger.ts";
import {
  abandonRun, openRunStatement, replaysOf, runEffects, runRow, triggerFactsOf,
  type RunEffectRow, type RunRow,
} from "./record.ts";
import type { ButlerRunPayload } from "./interpret.ts";

/**
 * The run ledger's two run-scoped replay modes: `inspect`, which executes nothing, and `re-run` (#53, §16).
 *
 * The two send-scoped modes — `retry-effect` and `resend-may-duplicate` — are `src/outbound/retry.ts`'s,
 * because the four states they turn on are states of a **manifest** and a manifest outlives every run.
 *
 * ## What the ledger holds, and what each mode reads
 *
 * There is no ledger table. #53 landed as four columns (migration 0030) on the two tables #50 shipped, and the
 * argument is in the migration: a second set of run tables beside `butler_runs` and `butler_run_effects` would
 * be two accounts of one run that can disagree. What the columns add is the **provenance** those tables could
 * not carry — what a run was given (`trigger_facts`), whether it is a replay of another and whose decision
 * that was (`replay_of`, `replayed_by`), and, on the send side, that one send deliberately repeats another
 * (`send_manifests.resend_of`).
 *
 * | mode | reads | writes |
 * |:--|:--|:--|
 * | `inspect` | the run row, the version's **frozen** `ast_json` and publication state, the pause in force, the effect rows in order, the current state of every send they produced, and any replays already made of this run | **nothing**, except the `supervised.opened` entry §7 requires when a *grant* is what let the viewer see the run's content fields — see `inspectRun` |
 * | `re-run` | the source run's `trigger_facts` — inherited — then the version's publication state, the pause, and everything the live path re-asks: policy, authority, approvals, breakers | a new `butler_runs` row carrying `replay_of` and `replayed_by`, in the same transaction as its audit entry |
 * | `retry-effect` | one manifest's `state`, `fidelity` and `submitted_key` | that manifest back to `held`, audited; then dispatch |
 * | `resend-may-duplicate` | the same three, plus the envelope and the author's **typed** body from R2 | a **new** manifest under a new key, with `resend_of` set |
 *
 * ## The line the whole design rests on: a replay **inherits the input and re-asks the judgement**
 *
 * Getting that backwards in the permissive direction means a replay doing what the live path would now refuse,
 * so each of the four governance inputs is decided rather than inherited by default:
 *
 *   - **Policy — re-asked.** A `re-run`'s sends go through `sealManifest`, which evaluates the **current**
 *     published policy, and through `dispatch.ts`, which re-evaluates it again for an approved send. So a
 *     policy published after the original ran refuses or gates the replay. §18's *"stricter policy fails
 *     closed"* is the rule; what makes it structural is that a replay has no path to an old decision —
 *     `policy_outcome` is written per manifest and a replay either seals a new one or seals none at all.
 *   - **Approval — re-asked, and structurally so.** An approval binds a manifest id (ADR 11, ADR 35). A
 *     materially-new replay effect gets a new manifest id, so the old approval refers to a manifest nobody
 *     will dispatch and a fresh one is requested if a policy still demands it. An effect whose content is
 *     **identical** reuses the old manifest and seals nothing, so there is nothing new for an approval to
 *     bind to and the original's approval is left exactly as it was. Neither path can reach an old approval
 *     for new bytes.
 *   - **Hold — three different things, and only two of them bear on a send.** The **hold window** is not
 *     inherited: a replay's manifest gets its own `release_at` from the replay's own instant, so the window
 *     to cancel it is a fresh one. A **policy hold** is a policy and is re-asked with the rest. A **legal
 *     hold** does not gate sending at all — `src/holds.ts` is a predicate standing between held mail and
 *     *destruction* — so a legal hold placed after the original ran neither stops a replay nor is inherited
 *     by one. That is said plainly rather than answered with an invented coupling: inventing one would be a
 *     control nobody asked for, on the one mechanism whose whole value is that it means exactly one thing.
 *   - **Breaker — re-asked, at three different points.** The **Butler pause** (#75) is asked here, before any
 *     run is created, because a pause refuses rather than gates: a paused Butler starts no run, and a replay
 *     is a start. `interpret` asks again per invocation, which is what catches a pause placed while a replay
 *     sleeps. The **domain pause** and the **rate breakers** are asked by `sealManifest` at the seal and by
 *     `dispatch.ts` at hand-over, unchanged.
 *
 * And a fifth that is not in the caution and belongs beside them: **publication state.** A replay runs the
 * **same version** the original ran, because a run is one walk of one program and running a different program
 * would be a new automation rather than a replay. If that version has been superseded or deleted it is no
 * longer `published`, and the replay is refused here — with `interpret`'s own `version_not_published` as the
 * second lock, for the version that is superseded between this check and the run.
 *
 * ## What a replay does to the run's cost counter, which is nothing
 *
 * `butler_runs.subrequests_spent` is the live input to the affordability guard and it is accumulated **per
 * instance**, because the pot is per instance. A replay is a **new instance with a new id**, so it opens its
 * own row with the counter at zero and the original's figure is never touched. There is no double count, and
 * the case that would have mattered is the one that now works: a run killed with `budget_exhausted` can be
 * replayed and gets a whole pot, rather than inheriting an exhausted one and being refused a replay that is in
 * fact affordable. The inverse is closed too — a replay cannot look cheaper by inheriting nothing.
 *
 * The two send-scoped modes spend nothing against any run's pot at all: they run in the request's invocation,
 * the way `triggerButlers` runs in the sweeper's, and nothing writes `subrequests_spent` from there.
 *
 * ## `simulate-recorded` is not built, and the reason is not that it is hard
 *
 * §16's fourth mode exists to *reuse immutable recorded LLM and connector outputs*, and both are Layer 6. At
 * Layer 4 there is no non-deterministic step to record: `expr.ts` is pure, and the effect nodes call the same
 * Layer 5 functions a person's request would. So a `simulate-recorded` here would replay deterministic output
 * and its interesting case — *does the recorded model answer reproduce the same decision* — would be
 * untestable, which is a mode whose tests could only prove that nothing was exercised. It arrives with
 * `llm.*` or `connector.*`, and arrives with something to reuse.
 */

/** Every mode this Node offers, as the tokens the API and the CLI use. */
export const REPLAY_MODES = ["inspect", "re-run", "retry-effect", "resend-may-duplicate"] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];

/** One recorded effect, plus what the send it produced is doing now. */
export interface InspectedEffect extends RunEffectRow {
  /**
   * Present only for a `mail.send.propose` whose manifest still exists.
   *
   * The offer is computed from the row this read already returns, so `inspect` names the send-scoped modes at
   * no extra cost — and `retryEffect` recomputes it inside its own conditional `UPDATE`, so what is shown here
   * is an offer rather than a promise.
   */
  readonly send?: {
    readonly state: string;
    readonly fidelity: string;
    readonly retry: RetryOffer;
    /** The send this one was already deliberately repeated as, if it was. */
    readonly resentAs: string | null;
  };
}

export interface RunInspection {
  readonly run: RunRow;
  /**
   * The frozen program, or null when its version row is gone.
   *
   * `checks` is `checkButler` over the stored AST — free, no subrequest — and it is what tells a reader
   * whether a `re-run` would refuse itself before performing anything.
   */
  readonly program: {
    readonly state: string;
    readonly trigger: unknown;
    readonly entry: unknown;
    readonly nodes: ReadonlyArray<{ id: string; type: string }>;
    readonly checks: boolean;
    readonly findings: string | null;
  } | null;
  /**
   * The `event.*` root the run was given, parsed — or null for a run opened before migration 0030.
   *
   * Null is a real answer and is reported as one. `re-run` refuses on it rather than re-deriving the facts,
   * because re-derived facts describe now: a case created since the run, a conversation merged since, an
   * address re-routed since.
   *
   * **Its content fields are null unless the viewer may read this mailbox's metadata** — see `inspectRun` and
   * `FACT_DISCLOSURE`. `triggerFactsRedacted` below says which, so a null is never mistaken for an answer.
   */
  readonly triggerFacts: unknown | null;
  /**
   * Which fact fields were withheld from **this** viewer, and why — or null when nothing was.
   *
   * In the answer rather than in a document, for the reason `notRecorded` is: a hole a reader cannot see is a
   * hole a reader will read past. An auditor who needs the subject line is told exactly what to ask for.
   */
  readonly triggerFactsRedacted: { readonly keys: readonly string[]; readonly why: string } | null;
  readonly effects: readonly InspectedEffect[];
  readonly replays: Awaited<ReturnType<typeof replaysOf>>;
  /** Whether `re-run` is offered, and — when it is not — the token saying which precondition failed. */
  readonly reRun: { readonly available: boolean; readonly why: ReRunRefusal | null };
  /**
   * What is **not** here, in the answer rather than in a document.
   *
   * A reader who sees `nodes` and `effects` will otherwise take the second for the walk. It is not: 0028
   * records a row per *effect*, and the pure nodes between them — every `guard`, `switch`, `transform`,
   * `validate`, `join`, `map`, `foreach`, `wait` and `stop` — performed no I/O and left no row. Which branch a
   * guard took is therefore not recorded and cannot be recovered from this; what is recorded is what the run
   * did to the world.
   */
  readonly notRecorded: string;
}

export type ReRunRefusal =
  | "input_not_recorded"
  | "version_not_published"
  | "version_missing"
  | "program_does_not_check"
  | "butler_paused";

const NOT_RECORDED =
  "The pure nodes of the walk are not recorded: this Node keeps one row per effect, not one per step, "
  + "because a guard, switch, transform, validate, join, loop, wait or stop performs no I/O. Which branch a "
  + "guard took is not recoverable from this record.";

interface ProgramRow {
  version_state: string | null;
  ast_json: string | null;
  butler_name: string | null;
  pause_id: string | null;
  pause_reason: string | null;
  pause_at: string | null;
}

/**
 * The version, the Butler's name and the pause in force, in one statement.
 *
 * The pause columns are correlated sub-selects on a read that has to happen anyway, which is #75's own trick:
 * asking whether the Butler is stopped costs nothing here either.
 */
async function programOf(env: Env, orgId: string, run: RunRow): Promise<ProgramRow | null> {
  return await env.CATALOG.prepare(
    `SELECT v.state AS version_state, v.ast_json, b.name AS butler_name,
            ${PAUSE_COLUMNS_FOR_RUN}
       FROM butler_versions v JOIN butlers b ON b.org_id = v.org_id AND b.id = v.butler_id
      WHERE v.org_id = ?1 AND v.id = ?2 LIMIT 1`,
  ).bind(orgId, run.version_id, run.butler_id).first<ProgramRow>();
}

/**
 * `inspect`: everything recorded about one run that **this viewer** may see, and nothing performed.
 *
 * ## `org.admin` is not enough for the trigger facts, and the comment that said it was, was wrong
 *
 * This function used to say *"reading what a Butler did is not a disclosure of anybody's mail content: every
 * field here is a state, an id or a token"*, and that was false. The run's `event.*` root carries `subject`,
 * `from`, `return_path` and `parse_error` — content by `trigger.ts`'s own declaration and by every other gate
 * in this repository — so an administrator holding nothing on any mailbox could read the subject line and the
 * sender of every message any Butler ever processed. `org.admin` is a relation on the *organization*; it
 * appears nowhere in `authz-read.ts`'s table of who may read a mailbox, and §7 is explicit that no relation
 * implies `message.read`. A false comment is worse than none: it is the sentence that stops anybody checking.
 *
 * So the run, the program, the effects, the send states and the replays stay `org.admin` — they are states,
 * ids and tokens, which is what that sentence was true about — and the **facts** are gated per mailbox.
 *
 * ## Which authority, and why it is the metadata one rather than `mailbox.content.read`
 *
 * `mayReadMetadata`, whose own contract is *"may this principal see the metadata of mail in this mailbox —
 * subject lines, sender addresses?"*. That is exactly and only what a fact set discloses: no body, no
 * attachment, no `.eml`. Requiring `mailbox.content.read` instead would refuse a subject line to the holder of
 * the relation that exists for nothing else, which is the "grants nothing" failure `mayReadMetadata`'s own
 * header was written about — and it would not refuse anybody extra, because `mailbox.content.read` satisfies
 * this check as the stronger of the two.
 *
 * ## A supervised grant opens it, and that is decided rather than inherited
 *
 * #63 built exactly the machinery this needs: one person, one mailbox, one scope, a deadline, two grantors who
 * are not the reader. An administrator investigating a Butler that mailed the wrong people is the case a grant
 * is *for*, and refusing it here would push them to `GET /api/messages` — the same subject lines, through a
 * door #63 already sanctioned. Either scope satisfies it, by `mayReadMetadata`'s asymmetry: you cannot read a
 * body without seeing its subject.
 *
 * ## What is recorded, and what is not — the audit question, answered rather than assumed
 *
 * **A grant that answers records `supervised.opened`, appended before the facts are returned.** #63 made that
 * structural on the single-object paths and this is one: unlike `listMessages`, the disclosure here is a single
 * known fact set, so the entry can name the message it was about at the moment of the check. `recordDisclosure`
 * throws, so a Node that cannot write its trail does not hand over the subject line.
 *
 * **A standing relation records nothing, and this is the part that needs the argument.** Every other
 * subject-line read in this product splits exactly this way — silent for the holder of an ordinary relation,
 * recorded when a grant is what answered. `queueFor` is the precedent to the letter: it gates on this same
 * `mayReadMetadata`, returns for a standing relation without appending anything, and calls `recordDisclosure`
 * only when `metadata.grantId` is non-null. `listMessages` records only its supervised arm, and `mayRead` —
 * which reaches an actual *body* — returns `true` on a standing relation before the append and records only
 * when a grant answered. The one path that records unconditionally is `authorizeExport`, and its reason is
 * stated there and does not apply here: an export takes a **copy off the Node**, which is a different question
 * (*what left*) from the one this answers (*who was let in*). `inspect` produces no copy and no bytes.
 *
 * So the "no entry per glance" argument survives for the ordinary reader — one untrimmable row every time
 * somebody opens a screen is the per-row frequency `audit-and-log-retention.md`'s sizing forbids, and this is a
 * screen people refresh — while the reader who has *no* standing authority is exactly the one who now cannot
 * get here at all without a grant, and a grant records every time. The hole #63 exists to prevent was an
 * unauthorized read that left no record; what remains is an authorized read that leaves none, which is the
 * product's settled rule for metadata rather than an exception carved for this route.
 *
 * §16's *"executes nothing"* therefore still holds for `inspect` as a mode: the only write it can make is the
 * disclosure record that §7 requires before a supervised reader is shown anything, and that is a precondition
 * of the read rather than an effect of the run.
 */
export async function inspectRun(
  env: Env,
  ctx: Ctx,
  who: Principal,
  runId: string,
): Promise<RunInspection | null> {
  const orgId = who.orgId;
  const run = await runRow(env, orgId, runId);
  if (run === null) return null;

  const [program, effects, replays, factsBlob] = await Promise.all([
    programOf(env, orgId, run),
    runEffects(env, orgId, runId),
    replaysOf(env, orgId, runId),
    // The blob is not on the run row — see the note at the end of `RunRow` — so it is read here, in the
    // batch that was already going out, and gated below before any of it reaches the answer.
    triggerFactsOf(env, orgId, runId),
  ]);

  /*
   * The frozen program, re-checked rather than trusted. Zero subrequests — `checkButler` is pure — and it
   * answers the question a reader of a five-week-old run actually has: would running this again refuse itself?
   * A node that has moved from shipped to reserved since publication makes `checks` false, and `re-run` says
   * so up front instead of minting a run whose only act is to refuse.
   */
  let described: RunInspection["program"] = null;
  if (program?.ast_json != null) {
    let parsed: unknown = null;
    let ok = false;
    let findings: string | null = null;
    try {
      parsed = JSON.parse(program.ast_json);
    } catch (error) {
      findings = `the stored AST is not JSON: ${(error as Error).message.split("\n")[0] ?? "unreadable"}`;
    }
    if (findings === null) {
      const checked = checkButler(parsed);
      ok = checked.ok;
      findings = checked.ok ? null : describeFindings(checked.findings);
    }
    const shape = (parsed ?? {}) as {
      trigger?: unknown; entry?: unknown; nodes?: Array<{ id?: unknown; type?: unknown }>;
    };
    described = {
      state: program.version_state ?? "unknown",
      trigger: shape.trigger ?? null,
      entry: shape.entry ?? null,
      // Ids and types only. The whole AST is on the version row and a reader who wants it asks for the
      // Butler; what an inspection needs is the shape the effect rows point into.
      nodes: (shape.nodes ?? []).map((node) => ({ id: String(node.id), type: String(node.type) })),
      checks: ok,
      findings,
    };
  }

  const sendSubjects = [...new Set(
    effects.filter((effect) => effect.node_type === "mail.send.propose" && effect.subject !== null)
      .map((effect) => effect.subject!),
  )];
  const sends = new Map<string, { state: string; fidelity: string; retry: RetryOffer; resentAs: string | null }>();
  if (sendSubjects.length > 0) {
    // One statement for every send in the run, not one per effect. The resend is found from the *other* end —
    // `snd_by_resend_of` is the index for it — so "was this repeated" needs no second read either.
    const { results } = await env.CATALOG.prepare(
      `SELECT m.id, m.state, m.fidelity, m.submitted_key IS NOT NULL AS has_submitted,
              (SELECT r.id FROM send_manifests r
                WHERE r.org_id = m.org_id AND r.resend_of = m.id ORDER BY r.sealed_at LIMIT 1) AS resent_as
         FROM send_manifests m
        WHERE m.org_id = ? AND m.id IN (${sendSubjects.map(() => "?").join(", ")})`,
    ).bind(orgId, ...sendSubjects).all<{
      id: string; state: string; fidelity: string; has_submitted: number; resent_as: string | null;
    }>();
    for (const row of results) {
      sends.set(row.id, {
        state: row.state,
        fidelity: row.fidelity,
        retry: retryOffer({ state: row.state, fidelity: row.fidelity, hasSubmitted: row.has_submitted === 1 }),
        resentAs: row.resent_as,
      });
    }
  }

  /*
   * The facts, gated per mailbox. See the header for which authority and why, and for the two decisions.
   *
   * `mailbox_id` is read off the **stored** blob rather than off a type, because that is what a stored blob is:
   * a run opened by a future trigger event may carry a fact set of another shape, and one whose mailbox cannot
   * be identified cannot be authorized against a mailbox. That case redacts everything content-classified —
   * fails closed — rather than guessing at a mailbox or refusing the whole inspection.
   */
  let triggerFacts: unknown = null;
  let triggerFactsRedacted: RunInspection["triggerFactsRedacted"] = null;
  if (factsBlob !== null) {
    const parsed = JSON.parse(factsBlob) as Record<string, unknown>;
    const factsMailbox = typeof parsed.mailbox_id === "string" ? parsed.mailbox_id : null;
    const authority = factsMailbox === null
      ? { allowed: false, grantId: null }
      : await mayReadMetadata(env, ctx, who, factsMailbox);

    if (authority.allowed) {
      if (authority.grantId !== null) {
        // Appended **before** the facts are returned, and `recordDisclosure` throws. `mayReadMetadata` cannot
        // write this for itself — its other caller authorizes a listing whose rows do not exist yet — so the
        // caller owes it, and here the caller knows exactly what one message it is about.
        await recordDisclosure(env, ctx, orgId, [supervisedActEvent(
          {
            action: "supervised.opened",
            subject: typeof parsed.message_id === "string" ? parsed.message_id : runId,
          },
          authority.grantId, who.userId, factsMailbox!,
        )]);
      }
      triggerFacts = parsed;
    } else {
      const withheld = redactFacts(parsed);
      triggerFacts = withheld.facts;
      triggerFactsRedacted = withheld.redacted.length === 0 ? null : {
        keys: withheld.redacted,
        why: factsMailbox === null
          ? "this run's recorded input names no mailbox, so no authority over it could be checked and every "
            + "field the sender may have written is withheld"
          : `these fields are mail content and reading it takes mailbox.metadata.read or `
            + `mailbox.content.read on ${factsMailbox}, or a live supervised grant on it (§7). org.admin is a `
            + "relation on the organization and confers neither. Everything else here — ids, states, tokens "
            + "and this Node's own timestamps — is unredacted",
      };
    }
  }

  const paused = pausedFrom(program);
  const why: ReRunRefusal | null =
    factsBlob === null ? "input_not_recorded"
      : program === null || program.ast_json === null ? "version_missing"
      : program.version_state !== "published" ? "version_not_published"
      : described?.checks !== true ? "program_does_not_check"
      : paused !== null ? "butler_paused"
      : null;

  return {
    run,
    program: described,
    triggerFacts,
    triggerFactsRedacted,
    effects: effects.map((effect) => {
      const send = effect.subject === null ? undefined : sends.get(effect.subject);
      return send === undefined ? effect : { ...effect, send };
    }),
    replays,
    reRun: { available: why === null, why },
    notRecorded: NOT_RECORDED,
  };
}

export interface ReRunStarted {
  readonly mode: "re-run";
  /** The new run's id, which is `<butlerVersionId>-<replayId>`. */
  readonly runId: string;
  readonly replayOf: string;
}

/**
 * `re-run`: a **new run** of the same program over the same recorded input, under everything current.
 *
 * ## Why the audit entry and the run row commit together
 *
 * A replay is the first thing in this product that deliberately repeats an act with external effects, so it is
 * plainly answerable: a named person decided to run a program again that proposes mail. `auditedBatch`'s
 * contract is *if the Node cannot record the act, it does not perform the act*, and that is the contract this
 * needs — which is why the row is inserted **here**, in the same transaction as the entry, rather than left to
 * the Workflow's own first statement. `interpret` calls the same `openRunStatement` with the same payload a
 * moment later, and `INSERT OR IGNORE` makes it the no-op it already had to be for a retried step.
 *
 * That also rules out the alternative that looks simpler: appending the entry with `audit` and creating the
 * instance afterwards. `audit` never throws by contract, so a Node that could not record would still start the
 * run — an unrecorded act with external effects, which is the wrong failure direction. `standalone` is for
 * refusals, where failing to record still refuses.
 *
 * ## The id, and why it is not the delivery's
 *
 * `<butlerVersionId>-<replayId>`. 0028 made the instance id the primary key precisely so one delivery cannot
 * produce two records of one version, so keying a replay on the delivery would collide with the record it is
 * replaying. The second half becomes the replay's own `brp_` ULID: the same shape — *the version, and what
 * made this run happen* — the same length to the character, and ADR 9's property intact, because for a replay
 * the intent **is** the person's decision rather than the delivery. Two clicks are therefore two runs, and
 * what stops the second sending a second copy is not the id but the content rule in `manifest.ts`.
 *
 * **That last sentence holds for the case people will hit, and it is bounded here rather than left reading
 * absolute.** The content rule compares a replay's send against *the source run's own* effects. So two replays
 * of one run whose content still matches the original both reuse the original's key and both seal nothing — one
 * message, whatever anybody clicks. But two replays whose content is materially new relative to the original
 * and **identical to each other** — the world moved once, between the original and the pair — are not compared
 * to one another, so each seals and the recipient gets two. The honest widening is one predicate on
 * `interpret`'s incumbent read (`e.run_id = ?1 OR e.run_id IN (SELECT id FROM butler_runs WHERE replay_of =
 * ?1)`), still one statement. It is not built because *"what have this run's siblings done"* is a different
 * question from *"what did the run I am replaying do"* and deserves deciding rather than arriving as a side
 * effect. Written down so the next reader finds the boundary instead of the promise.
 *
 * ## A replay of a replay is allowed
 *
 * `replay_of` points at whatever run was asked for, so a chain is visible rather than flattened. Refusing one
 * would need a rule with no argument behind it: the second replay is as governed as the first, re-asks
 * everything the first re-asked, and reuses the keys of whatever run it names.
 */
export async function replayRun(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  runId: string,
): Promise<ReRunStarted> {
  const run = await runRow(env, orgId, runId);
  if (run === null) {
    throw notFound("E_NO_SUCH_RUN", {
      what: `${runId} is not a run in this organization`,
      why: "a replay is of a recorded run; there is nothing here to replay",
      fix: "check the id against GET /api/butler-runs",
    });
  }

  /*
   * The input, the program and the pause, in one round trip. The facts are read through `triggerFactsOf`
   * rather than off the run row because the row deliberately does not carry them — see the note at the end of
   * `RunRow`. Checked first, so the order of refusals is unchanged by where the read moved to.
   */
  const [program, factsBlob] = await Promise.all([
    programOf(env, orgId, run),
    triggerFactsOf(env, orgId, runId),
  ]);

  if (factsBlob === null) {
    throw conflict("E_REPLAY_INPUT_NOT_RECORDED", {
      what: `run ${runId} was recorded before this Node stored what a run was given`,
      why: "a replay runs the same program over the same input, and re-deriving the input would describe now "
        + "rather than then — a case created since, a conversation merged since, an address re-routed since. "
        + "Running a program over different input is not a replay of anything",
      fix: "inspect this run instead (GET /api/butler-runs/:id/inspect); runs opened after migration 0030 "
        + "record their input and are replayable",
    });
  }

  if (program === null || program.ast_json === null) {
    throw conflict("E_REPLAY_VERSION_MISSING", {
      what: `the version run ${runId} executed (${run.version_id}) no longer exists`,
      why: "a replay runs the same program, and 0027 says plainly that a published version is immutable "
        + "rather than indestructible",
      fix: "inspect the run for what it did; there is no program left to run again",
    });
  }
  if (program.version_state !== "published") {
    throw conflict("E_REPLAY_VERSION_NOT_PUBLISHED", {
      what: `version ${run.version_id} is ${program.version_state}, not published`,
      why: "a replay runs the same version the run ran, because a run is one walk of one program — running "
        + "the current version instead would be a new automation rather than a replay. #49's lifecycle rests "
        + "on a draft never executing",
      fix: "publish the current draft and let a new delivery run it, or inspect this run instead",
    });
  }

  const checked = checkButler(JSON.parse(program.ast_json));
  if (!checked.ok) {
    throw conflict("E_REPLAY_PROGRAM_DOES_NOT_CHECK", {
      what: `version ${run.version_id} no longer checks: ${describeFindings(checked.findings)}`,
      why: "the interpreter re-checks a stored AST before performing anything, so this replay would refuse "
        + "itself. Refusing here says the same thing without minting a run whose only act is to fail",
      fix: "republish the Butler without the refused node",
    });
  }

  /*
   * The pause, asked before a run exists, because a pause is an abuse breaker: it **refuses** rather than
   * gating, so the answer is that no run happens. That is `triggerButlers`' rule and this is the second place a
   * run can start, so it is the second place the question has to be asked. `interpret` asks again per
   * invocation, which covers a pause placed while a replay sleeps.
   */
  const paused = pausedFrom(program);
  if (paused !== null) {
    throw conflict("E_BUTLER_PAUSED", {
      what: describePause(paused, { id: run.butler_id, name: program.butler_name ?? run.butler_id }),
      why: "a paused Butler starts no runs, and a replay is a start. Letting a replay through would make the "
        + "pause a rule about deliveries rather than about the Butler",
      fix: "resume it with a reason first — POST /api/butler-pauses/:id/resume",
    });
  }

  const replayId = ctx.id("brp");
  const newRunId = `${run.version_id}-${replayId}`;
  const idMax = BUDGETS["workflow.instance_id_max_chars"];
  if (newRunId.length > idMax) {
    throw conflict("E_BUDGET_EXCEEDED", {
      what: `workflow.instance_id_max_chars=${idMax}, this replay's id would be ${newRunId.length}`,
      why: "a typed-prefix ULID pair comes to 61, so this is a tripwire past where any real id goes and only "
        + "a changed id scheme reaches it",
      fix: "receipt docs/receipts/workflow-provisioning.md",
    });
  }

  const payload: ButlerRunPayload = {
    orgId,
    butlerId: run.butler_id,
    butlerVersionId: run.version_id,
    trigger: {
      event: run.trigger_event,
      key: run.trigger_key,
      // The **recorded** facts, inherited unchanged. See the header: the input is inherited and the judgement
      // is re-asked.
      facts: JSON.parse(factsBlob) as Readonly<Record<string, unknown>>,
    },
    replay: { ofRunId: runId, byUserId: actorUserId },
  };

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.replayed",
      outcome: "ok",
      actorUserId,
      subject: newRunId,
      detail: {
        mode: "re-run",
        replayOf: runId,
        butlerId: run.butler_id,
        versionId: run.version_id,
        triggerKey: run.trigger_key,
        // What the original run did, so the trail says what is being repeated rather than only that something
        // was. A reader deciding whether this replay was reasonable is asking exactly this.
        originalState: run.state,
        originalReason: run.outcome_reason,
        originalEffects: run.effects,
      },
    },
    (entry) => [
      entry,
      openRunStatement(env, ctx, {
        runId: newRunId, orgId,
        butlerId: run.butler_id,
        versionId: run.version_id,
        triggerEvent: run.trigger_event,
        triggerKey: run.trigger_key,
        triggerFacts: factsBlob,
        replay: payload.replay!,
      }),
    ],
  );

  try {
    await env.BUTLER_RUNS.create({ id: newRunId, params: payload });
  } catch (error) {
    /*
     * The record exists and the instance does not. Closed as `failed` with a reason rather than left reading
     * `running` for ever — `abandonRun` states no counts, because this act knows the run performed nothing and
     * `closeRun`'s zeroes would be a claim rather than a fact.
     *
     * Re-raised, always: the caller asked for a run and there isn't one, and a Node that answered 200 here
     * would be reporting a replay that never started. `release.ts` swallows the mirror-image failure because
     * there the *send* was already released and the instance is a courtesy; here the instance is the whole act.
     */
    await abandonRun(env, ctx, orgId, newRunId, "failed", "replay_instance_not_created");
    throw error;
  }

  return { mode: "re-run", runId: newRunId, replayOf: runId };
}
