import {
  checkButler, describeFindings, RUN_BUDGET, RUN_BUDGET_NAME,
  type Butler, type ButlerNode, type ShippedKind,
} from "@mailda/butler-ast";
import { conflict, notFound, unprocessable } from "../errors.ts";
import type { ReadOnlyEnv } from "../read-only.ts";
import { caseMailboxHeldBy, effectiveOnMailbox, notAnId } from "./authority.ts";
import { ceilingOf } from "./ceiling.ts";
import { lookupRow, type EffectResult } from "./effects.ts";
import { evaluate, ButlerFault, type RunState } from "./expr.ts";
import { parentDelivery, replyRecipients } from "./parent.ts";
import type { ButlerPrincipal } from "./principal.ts";
import type { EffectOutcome, TerminalState } from "./record.ts";
import { RUN_NODE_COST } from "./interpret.ts";
import { walk, type Terminal, type WalkCounts, type Walkable } from "./walk.ts";
import type { EffectHandle } from "./world.ts";

/**
 * The dry run (#87, §5's fifth charted answer, blueprint:347 *"simulation cannot affect production"*).
 *
 * ## What makes this safe, and it is not a flag
 *
 * **Every function in this file takes `ReadOnlyEnv`.** There is no `Env` in the module and no import that
 * reaches one, so `liveEffects` cannot be called here, `saveDraft` cannot be called here, and neither can the
 * write anybody adds next year — not because a check refuses it but because it does not compile.
 * `src/read-only.ts` carries the argument for the type; `test/butler-world.test.ts` witnesses it with
 * `@ts-expect-error`, which is the only assertion that can witness a compile error.
 *
 * The narrowing happens once, at the route, in the expression `readOnly(env)`. That is the single line to
 * read when asking *how could a simulation write?* — and the answer is visible rather than argued.
 *
 * ## It is the same walk, which is the only version of this worth having
 *
 * `walk.ts` is shared with `interpret`. Same switch, same guards, same loop bounds, same affordability
 * arithmetic, same expression evaluator. Two copies would have been the correspondence problem this
 * repository keeps paying for, in the worst place available: **a simulation that diverges from the engine is
 * a tool that tells authors their Butler is fine.**
 *
 * So what differs is only the `Walkable` handed to it, and the differences are enumerable — which is the
 * point of having extracted it.
 *
 * ## Every check that does not depend on an unwritten row is really performed
 *
 * This is what separates a dry run worth running from one that prints the graph. All of the following are
 * **real** here, against real rows:
 *
 * | Asked for real | Because |
 * |:--|:--|
 * | the AST re-check | `checkButler`, the same call publication and every run make |
 * | every expression | `expr.ts` is pure; a `${…}` that does not resolve faults here exactly as it would live |
 * | loop bounds, `maxItems` | arithmetic in the shared walk |
 * | affordability | `RUN_NODE_COST` against `RUN_BUDGET`, so *"this Butler cannot afford to run"* is answerable before publishing |
 * | `lookup` | the **real** `lookupRow`, narrowed to a read handle for exactly this reason |
 * | a case's actionability | the real `caseMailboxHeldBy` — the Butler's ceiling ∩ its tuples ∩ its sponsor's |
 * | a mailbox's authority | the real `effectiveOnMailbox`, which is #51's three-term intersection |
 * | **who a reply would go to** | `parentDelivery` + `replyRecipients`, both pure, both reading the real trigger |
 *
 * That last row is the answer an author actually wants from a dry run, and it is exact rather than
 * approximate: the recipients are derived from the parent delivery by the same code that derives them live.
 *
 * ## And the limit is reported rather than hidden
 *
 * A simulation does not write a draft, so from the `draft` node onward it is reasoning about a row that does
 * not exist. `mail.send.propose` normally *reads that draft back* to compute its content identity, and the
 * seal is where policy, the breakers and #61's approval are decided — against content this run did not
 * store.
 *
 * Rather than fabricate an answer, the simulated `draft` binds a value marked `simulated: true`, and
 * `proposeSend` checks the authority it genuinely can — `send.propose` on the same mailbox — then reports
 * `would` and names what was not evaluated. Every `Simulation` carries a `limits` list saying so in words.
 * A dry run that quietly implied policy had been checked would be worse than no dry run: it would be a green
 * light nobody granted.
 */

/** The marker a simulated `draft` binds instead of a row id. Reaching this in a real run is impossible. */
const SIMULATED_DRAFT = "dft_simulated";

/** One node's effect, as a dry run can report it. */
export interface SimulatedEffect {
  readonly seq: number;
  readonly nodeId: string;
  readonly nodeType: string;
  /**
   * Three values, and the distinction is the whole honesty of the report.
   *
   * - `ok` / `refused` — a **real** answer from a real read. The Butler is or is not permitted; the row is or
   *   is not readable. Identical to what a live run would have recorded.
   * - `would` — the read said yes and the write was not performed. This is where a live run would have
   *   changed something.
   *
   * `failed` is the third member of `EffectOutcome` and is carried through rather than filtered out: an
   * effect that faults in a dry run faulted for a reason that would also have faulted live, and hiding it
   * would make the one outcome an author most needs to see the one the report cannot express.
   */
  readonly outcome: EffectOutcome | "would";
  readonly reason: string | null;
  readonly subject: string | null;
  /** What the dry run established for real, in the shape the author's own node named it. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface Simulation {
  readonly butlerId: string;
  readonly butlerName: string;
  readonly versionId: string;
  /** `null` for a draft, which is the version an author iterating on a Butler wants simulated. */
  readonly version: number | null;
  readonly state: TerminalState;
  readonly reason: string | null;
  readonly nodesExecuted: number;
  readonly effects: readonly SimulatedEffect[];
  /** What a live run of this walk would have spent, by the same table the engine reserves from. */
  readonly wouldSpend: number;
  /** Every `as` binding the walk produced, so an author can see what their expressions resolved to. */
  readonly bindings: Readonly<Record<string, unknown>>;
  /** What this dry run could not evaluate, in words, and why. Never empty when a send was proposed. */
  readonly limits: readonly string[];
}

/** What a dry run is given to walk over. */
export interface SimulationInput {
  /**
   * The trigger's facts.
   *
   * Supplied by the caller rather than derived, because a dry run is *"what would this program do given
   * this"*. The shape has to be a delivery's facts for `draft` to derive recipients — a malformed one faults
   * in `parentDelivery`, with the same message a live run would give, which is itself a useful answer.
   */
  readonly facts: Readonly<Record<string, unknown>>;
  /** Defaults to the trigger the version declares, which is the only event that could fire it. */
  readonly event?: string;
  readonly key?: string;
}

/** The version a dry run walks: the draft if there is one, otherwise what is live. */
interface SimulatedVersion {
  id: string;
  version: number | null;
  state: string;
  astJson: string;
  butlerName: string;
  sponsorUserId: string | null;
}

/**
 * Simulates the Butler's current program.
 *
 * **The draft in preference to the published version**, which is the same fallback
 * `src/client/app/screens/butlers.tsx` makes and for the same reason inverted: the editor shows the draft
 * because that is what you are working on, and a dry run tests what you are working on. Testing the live
 * version while an author edits a draft would answer a question nobody asked.
 *
 * Refuses rather than defaults when there is no version at all: a Butler with neither draft nor published
 * version has no program, and simulating nothing would report a clean walk over an empty graph.
 */
export async function simulateButler(
  env: ReadOnlyEnv,
  orgId: string,
  /**
   * Who asked.
   *
   * Needed for one thing only, and it is the honest answer to a real gap: a **draft** has no publisher, so
   * there is no sponsor to cap its ceiling against. The person asking is the closest true answer — they are
   * the one who would publish it next — and `limits` says so in words rather than letting the report imply
   * the ceiling is the one publication will pin.
   */
  actorUserId: string,
  butlerId: string,
  input: SimulationInput,
): Promise<Simulation> {
  /*
   * No `Ctx`, deliberately, and it is worth a line because every other entry point in this engine takes one.
   *
   * `Ctx` is the clock, the id minter and the randomness seam, and a dry run needs none of the three: it
   * writes no row that carries a timestamp, mints no identifier — `dft_simulated` is a constant, not an id —
   * and makes no random choice. Taking one anyway would be a capability with nothing to reach, in the file
   * whose whole subject is which capabilities a run is constructed with.
   */
  const version = await currentVersion(env, orgId, butlerId);

  const checked = checkButler(JSON.parse(version.astJson));
  if (!checked.ok) {
    /*
     * The same failure `publishButler` gives, and reachable here for the same reason: the node set is a
     * declaration, and a node moving from shipped to reserved makes a stored draft unwalkable. Refusing here
     * is what stops a dry run reporting a terminal state for a program the engine would not accept.
     */
    throw unprocessable("E_BUTLER_DOES_NOT_CHECK", {
      what: `this Butler has ${checked.findings.length} problem(s):\n${describeFindings(checked.findings)}`,
      why: "a dry run walks the same checked AST a live run does, so a program the checker refuses has "
        + "nothing to simulate — and reporting a walk over it would be a green light for a Butler that "
        + "cannot be published",
      fix: "fix the findings above and save the draft again",
    });
  }
  const ast: Butler = checked.ast;

  if (version.sponsorUserId === null && version.state === "published") {
    throw conflict("E_BUTLER_VERSION_HAS_NO_SPONSOR", {
      what: `published version ${version.id} records no publisher`,
      why: "the capability ceiling is capped against the sponsor's live authority (#51), so a version with "
        + "no sponsor has no ceiling and every authority answer below would be a guess",
      fix: "publish the Butler again; publication records who did it",
    });
  }

  /*
   * The sponsor for a **draft** is the person who would publish it, and nobody has.
   *
   * So a draft is simulated against the *actor*'s authority — which is the honest reading and has to be said
   * plainly, because it is the one place a dry run's answer can differ from the live run's: publish it and the
   * ceiling is capped against whoever publishes, who may hold less. `limits` says so.
   */
  const sponsorUserId = version.sponsorUserId ?? actorUserId;

  const butler: ButlerPrincipal = {
    orgId,
    butlerId,
    versionId: version.id,
    name: version.butlerName,
    ceiling: ceilingOf(ast, sponsorUserId),
  };

  const trigger = {
    event: input.event ?? ast.trigger.event,
    key: input.key ?? "simulated",
    facts: input.facts,
  };

  const state: RunState = {
    event: trigger.facts,
    butler: { id: butlerId, versionId: version.id, name: version.butlerName },
    steps: {},
  };

  const counts: WalkCounts = { nodesExecuted: 0, effects: 0, refusals: 0 };
  const recorded: SimulatedEffect[] = [];
  const limits: string[] = [];
  let spent = 0;

  const visits = new Map<string, number>();

  /*
   * The dry run's effect handle.
   *
   * Not `liveEffects`, and it could not be: that function requires an `Env` and this file has none. Each
   * entry below performs every read the live effect performs and stops at the write, which is why the
   * refusals it reports are the real ones rather than a model of them.
   */
  const effects: EffectHandle = {
    // The real function. Narrowed to a read handle precisely so there is one lookup rather than two.
    lookup: async (node, s) => await lookupRow(env, butler, node, s),

    assignCase: async (node, s) => {
      const caseId = text(evaluate(node.caseId, s, node.id));
      const assignee = text(evaluate(node.assignee, s, node.id));
      if (caseId === null) throw notAnId(node.id, "case", caseId);
      if (assignee === null) throw notAnId(node.id, "assignee", assignee);
      /*
       * The real actionability read: the Butler's ceiling ∩ its tuples ∩ its sponsor's, against the real
       * case row. A `case_not_actionable` here is the answer a live run would give.
       *
       * What is *not* asked is whether the **assignee** may work it — `claim` answers that, and `claim`
       * writes. Named in `limits` rather than guessed at.
       */
      const target = await caseMailboxHeldBy(env, butler, caseId, "send.propose");
      if (target === null) return refused("case_not_actionable", caseId);
      if (target.state === "closed") return refused("case_closed", caseId);
      note(limits, `${node.id}: whether ${assignee} may work this case is decided by the claim, which a dry `
        + "run does not perform");
      return {
        outcome: "ok", reason: null, subject: caseId,
        // `would`, promoted by `perform` below. The detail is what a live run would have changed.
        bind: { simulated: true, would: "claim", caseId, assignee, mailboxId: target.mailboxId },
      } as EffectResult;
    },

    closeCase: async (node, s) => {
      const caseId = text(evaluate(node.caseId, s, node.id));
      if (caseId === null) throw notAnId(node.id, "case", caseId);
      const target = await caseMailboxHeldBy(env, butler, caseId, "send.propose");
      if (target === null) return refused("case_not_actionable", caseId);
      /*
       * `closeCase` requires the closer to be **holding** the case, so this is the one refusal a dry run can
       * give in full: the holder is a column of the row already read.
       */
      if (target.assignee !== butlerId) return refused("case_not_held", caseId);
      return {
        outcome: "ok", reason: null, subject: caseId,
        bind: { simulated: true, would: "close", caseId },
      } as EffectResult;
    },

    writeDraft: async (node, s, t) => {
      /*
       * The most useful thing a dry run can answer, and all of it is real.
       *
       * The mailbox comes off the node, the recipients are derived from the parent delivery by the same two
       * pure functions the live path uses, the subject and body are the author's own expressions evaluated,
       * and `effectiveOnMailbox` is #51's three-term intersection against real tuples. Nothing here is
       * modelled — the only thing not done is the `saveDraft` at the end.
       */
      const mailboxId = text(evaluate(node.mailboxId, s, node.id));
      if (mailboxId === null) throw notAnId(node.id, "mailbox", mailboxId);
      const to = replyRecipients(parentDelivery(t, node.id));
      const subject = String(evaluate(node.subject, s, node.id));
      const body = String(evaluate(node.body, s, node.id));

      const effective = await effectiveOnMailbox(env, butler, mailboxId, ["send.propose"]);
      if (!effective.allowed) return refused(effective.reason, mailboxId);

      return {
        outcome: "ok", reason: null, subject: SIMULATED_DRAFT,
        bind: {
          simulated: true, would: "save a draft",
          id: SIMULATED_DRAFT, mailboxId, to, subject,
          // The body's length rather than the body: a dry run's report is read in a browser, and an
          // author-controlled string of up to a D1 row's worth of bytes is not a field to render.
          bodyBytes: new TextEncoder().encode(body).byteLength,
        },
      } as EffectResult;
    },

    proposeSend: async (node, s) => {
      /*
       * Where the dry run's knowledge ends, and it says so rather than implying otherwise.
       *
       * A live `mail.send.propose` reads the draft back out of storage and seals a manifest, and the seal is
       * where `policy.ts` decides, `approvals.ts` gates and `breakers.ts` trips — all against content this
       * run did not store. So the authority that *can* be asked is asked, for real, and the rest is named.
       */
      const resolved = evaluate(node.draft, s, node.id);
      const bound = resolved !== null && typeof resolved === "object"
        ? (resolved as Record<string, unknown>)
        : {};
      const mailboxId = text(bound.mailboxId);

      if (mailboxId !== null) {
        const effective = await effectiveOnMailbox(env, butler, mailboxId, ["send.propose"]);
        if (!effective.allowed) return refused(effective.reason, mailboxId);
      }

      note(limits, `${node.id}: the send's policy decision, rate breakers and approval gate are made when the `
        + "manifest is sealed, against a draft a dry run does not write — so this reports that a send would "
        + "be proposed, never that it would be sent");

      return {
        outcome: "ok", reason: null, subject: text(bound.id) ?? SIMULATED_DRAFT,
        bind: {
          simulated: true, would: "propose a send",
          mailboxId, to: bound.to ?? null, subject: bound.subject ?? null,
        },
      } as EffectResult;
    },
  };

  const world: Walkable = {
    byId: new Map(ast.nodes.map((node) => [node.id, node])),
    state,
    trigger,
    // A dry run is never a replay: the two ask different questions, and #53's incumbent-send machinery exists
    // to stop a replay duplicating mail a dry run cannot send in the first place.
    incumbents: null,
    effects,
    counts,
    nameFor: (nodeId) => {
      const visit = (visits.get(nodeId) ?? 0) + 1;
      visits.set(nodeId, visit);
      return `${nodeId}#${visit}`;
    },
    steps: {
      // Inline, because there is no Workflow instance and nothing to resume: a dry run is one request.
      do: async (_name, body) => await body(),
      sleep: async (_name, seconds) => {
        /*
         * Reported, not slept. A `wait` node in a live run costs no concurrency and can reach 365 days;
         * sleeping here would hang a request, and skipping it silently would let an author believe their
         * Butler runs to completion promptly when it pauses for a week.
         */
        note(limits, `a wait node would pause this run for ${seconds}s; a dry run walks straight past it`);
      },
    },
    perform: async (node, _step, body) => {
      const seq = recorded.length + 1;
      const outcome = await body();
      spent += RUN_NODE_COST[node.type as ShippedKind];
      /*
       * `ok` becomes `would` for the four nodes that write, and stays `ok` for `lookup`.
       *
       * The distinction is the report's whole value: a reader has to be able to tell an answer this Node
       * actually got from a write it declined to make, and one word for both would have hidden exactly that.
       */
      const detail = outcome.bind as Record<string, unknown> | undefined;
      const simulated = detail?.simulated === true;
      recorded.push({
        seq,
        nodeId: node.id,
        nodeType: node.type,
        outcome: outcome.outcome === "ok" && simulated ? "would" : outcome.outcome,
        reason: outcome.reason,
        subject: outcome.subject,
        detail,
      });
      if (outcome.outcome === "ok") counts.effects += 1;
      if (outcome.outcome === "refused") counts.refusals += 1;
      // The binding the walk carries forward: what a live run would have bound, marked as simulated.
      return outcome;
    },
    // Nothing to record against: there is no run row, and the terminal is the return value.
    complain: async () => {},
    affordable: (node) => spent + RUN_NODE_COST[node.type as ShippedKind] <= RUN_BUDGET,
    exhausted: async (node): Promise<Terminal> => {
      note(limits, `${RUN_BUDGET_NAME}=${RUN_BUDGET} and this walk reached ${spent} before ${node.id} `
        + `(a ${node.type}) needed ${RUN_NODE_COST[node.type as ShippedKind]} more`);
      return { state: "refused", reason: "budget_exhausted" };
    },
    // A dry run never waits for a person: the park is reported by `proposeSend` and the walk carries on, so
    // an author sees the rest of their program rather than the point it would have stopped at.
    awaitRelease: async () => null,
  };

  if (version.state === "draft") {
    note(limits, "this is the draft, and a draft has no publisher — so the capability ceiling was capped "
      + "against your own authority. Publishing caps it against whoever publishes, who may hold less");
  }

  const terminal = await walk(world, ast.entry);

  return {
    butlerId,
    butlerName: version.butlerName,
    versionId: version.id,
    version: version.version,
    state: terminal.state,
    reason: terminal.reason,
    nodesExecuted: counts.nodesExecuted,
    effects: recorded,
    wouldSpend: spent,
    bindings: state.steps,
    limits,
  };
}

/** The draft if there is one, otherwise the published version. */
async function currentVersion(
  env: ReadOnlyEnv,
  orgId: string,
  butlerId: string,
): Promise<SimulatedVersion> {
  const row = await env.CATALOG.prepare(
    `SELECT v.id, v.version, v.state, v.ast_json, v.published_by, b.name AS butler_name
       FROM butler_versions v
       JOIN butlers b ON b.id = v.butler_id AND b.org_id = v.org_id
      WHERE v.org_id = ? AND v.butler_id = ? AND v.state IN ('draft', 'published')
      -- 'draft' sorts before 'published', so one ORDER BY expresses the preference.
      ORDER BY v.state = 'draft' DESC
      LIMIT 1`,
  ).bind(orgId, butlerId).first<{
    id: string; version: number | null; state: string; ast_json: string;
    published_by: string | null; butler_name: string;
  }>();

  if (row === null) {
    // A Butler in another organization and one that never existed answer identically (§5C).
    throw notFound("E_NO_SUCH_BUTLER", {
      what: `${butlerId} has no draft and no published version in this organization`,
      why: "a dry run walks a program, and there is none to walk",
      fix: "save a draft first",
    });
  }

  return {
    id: row.id,
    version: row.version,
    state: row.state,
    astJson: row.ast_json,
    butlerName: row.butler_name,
    sponsorUserId: row.published_by,
  };
}

/** Adds a limit once. The same node type can hit the same limit repeatedly and it is one fact. */
function note(limits: string[], message: string): void {
  if (!limits.includes(message)) limits.push(message);
}

function refused(reason: string, subject: string): EffectResult {
  return { outcome: "refused", reason, subject };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Re-exported so a caller can distinguish a fault in the author's program from a refusal about it. */
export { ButlerFault };
