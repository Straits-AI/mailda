import type { ButlerNode } from "@mailda/butler-ast";
import type { Ctx } from "@mailda/runtime";

import { claim, close } from "../cases.ts";
import { readDraft, saveDraft } from "../drafts.ts";
import { CallerError } from "../errors.ts";
import { sealManifest } from "../outbound/manifest.ts";
import { caseMailboxHeldBy, notAnId, readEntity } from "./authority.ts";
import { BUTLER_RELEASE_REASON } from "./gate.ts";
import { evaluate, type RunState } from "./expr.ts";
import { parentDelivery, replyRecipients, type RunTrigger } from "./parent.ts";
import type { EffectOutcome } from "./record.ts";
import type { ButlerPrincipal } from "./principal.ts";

/**
 * The four effect nodes and `lookup`, each calling **what a human calls** (#50).
 *
 * ## The one rule this file exists to keep
 *
 * A Butler is a caller. `case.assign` is `claim`, `case.close` is `close`, `draft` is `saveDraft`,
 * `mail.send.propose` is `sealManifest`. Not a copy of any of them — so every policy decision, every
 * approval gate, every circuit breaker, every authority check and every audit entry happens because the
 * same function ran, with a different principal. `test/butler-step-cost.measure.test.ts` priced those four
 * functions before this engine existed *on that basis*, and the figures only mean anything while it holds.
 *
 * What this file adds around each call is four things and nothing else: it resolves the node's expressions,
 * it checks **the Butler's own** authority where the function checks somebody else's, it turns the answer
 * into a row of the run record, and — for `draft` — it **supplies the recipients the node does not carry.**
 *
 * That last one is #52. `draft` has no `to`, `cc` or `bcc`: §16 forbids untrusted content selecting or
 * constructing them, and an `Expr` reads `event.*`, which is the inbound message. So the address comes from
 * the delivery that triggered the run (`parent.ts`) and a program cannot influence it. The cost is real and
 * stated where authors meet it: a Butler cannot CC a colleague, add a supervisor, or forward.
 *
 * ## Being refused is a first-class outcome, not an error
 *
 * Every one of those functions can refuse — a policy denies, a breaker pauses a domain, an approval cannot
 * be satisfied, a case is held by somebody else, a relation was never granted. **That is the system
 * working**, so it is recorded and the run carries on to the node's `next`. A thrown error would make a
 * governed refusal indistinguishable from a bug, and would abandon the rest of a program whose author may
 * well have intended the other branch to run.
 *
 * The run does *not* branch on it, and that is a limit worth naming rather than hiding: the shipped AST has
 * no failure edge — a node carries one `next` — so a Butler cannot say *"if the send was denied, assign the
 * case to a human instead"*. What it can do is read the outcome from the run record afterwards. A second
 * edge is a change to #49's node shapes and belongs there.
 *
 * ## Where the Butler's own authority is checked, and where it is not
 *
 * | node | who the Layer 5 function checks | so this file checks |
 * |:--|:--|:--|
 * | `case.assign` | the **assignee**'s `send.propose` (`claim`) | the Butler's `send.propose` on the case's mailbox |
 * | `case.close` | that the closer **holds** the case (`close`) | the Butler's `send.propose` on the case's mailbox |
 * | `draft` | the author's `send.propose` (`assertMaySend`) | nothing — the author *is* the Butler. It does supply the recipients, which the node cannot name (#52) |
 * | `mail.send.propose` | the author's `send.propose` (`maySend`) | nothing — same reason |
 * | `lookup` | nothing: it is a row read | the Butler's read relation, folded into the statement |
 *
 * The first row is the one that matters. `claim` checks whether the **assignee** may work the case, which is
 * exactly right for a human clicking Reply and exactly not enough for a program: without the extra check a
 * Butler holding nothing anywhere could assign any case in the organization to anybody who may work it.
 * That is the permissive direction, and it is the reason `caseMailboxHeldBy` exists.
 */

/** What one effect node did, as the interpreter needs it. */
export interface EffectResult {
  readonly outcome: EffectOutcome;
  /** The machine token behind the outcome, or null. See migration 0028 on the two families. */
  readonly reason: string | null;
  /** What was produced or touched — a manifest, draft or case id. Where an ADR 9 effect key lands. */
  readonly subject: string | null;
  /** What to bind under the node's `as`. Absent when the node binds nothing. */
  readonly bind?: unknown;
  /** Set when the run must park for a human release before going on. */
  readonly park?: string;
}

/**
 * The refusal tokens **this engine** decides, as opposed to the ones it reads back off a manifest or gets
 * from a `CallerError`.
 *
 * Enumerated because a reason nobody can list is a reason nobody can filter on, and because the run
 * listing shows them. `test/butler-run.test.ts` pins the set so a seventh cannot arrive without a decision.
 */
export const EFFECT_REASONS = [
  /** The case does not exist, or this Butler holds nothing on the mailbox it is in. §5C keeps them alike. */
  "case_not_actionable",
  /** Somebody — or some other Butler — is already holding it. */
  "case_held",
  /** It is closed, so there is nothing to assign and nothing to close. */
  "case_closed",
  /** `claim` refused the *assignee*: they may not send as the mailbox the case is in. */
  "assignee_may_not_work_it",
  /** `close` refused: a Butler may only close a case it is itself holding. */
  "case_not_held_by_butler",
  /** The lookup resolved to nothing this Butler may read. Absent and forbidden answer alike (§5C). */
  "not_readable",
] as const;

export type EffectReason = (typeof EFFECT_REASONS)[number];

function refused(reason: string, subject: string | null = null): EffectResult {
  return { outcome: "refused", reason, subject };
}

/**
 * Runs one effect node, converting a `CallerError` into a refusal.
 *
 * `CallerError` is *by definition* "the value was understood and refused" (`src/errors.ts`), so its stable
 * code is a refusal token and is recorded as one. Anything else propagates: an unreadable D1, a broken
 * vault, a bug. That distinction is the whole reason this wrapper is one function rather than a `try` in
 * each handler — a `catch` that swallowed both would turn a fault into a governance decision, which is the
 * silent direction and the one AGENTS.md names.
 */
async function refusable(body: () => Promise<EffectResult>): Promise<EffectResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CallerError) return refused(error.code);
    throw error;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `case.assign`: `claim`, with the Butler's own authority checked first. */
export async function assignCase(
  env: Env,
  ctx: Ctx,
  butler: ButlerPrincipal,
  node: Extract<ButlerNode, { type: "case.assign" }>,
  state: RunState,
): Promise<EffectResult> {
  const caseId = text(evaluate(node.caseId, state, node.id));
  const assignee = text(evaluate(node.assignee, state, node.id));
  if (caseId === null) throw notAnId(node.id, "case", caseId);
  if (assignee === null) throw notAnId(node.id, "assignee", assignee);

  return await refusable(async () => {
    const target = await caseMailboxHeldBy(env, butler, caseId, "send.propose");
    if (target === null) return refused("case_not_actionable", caseId);

    /*
     * No early return for a closed case here, and that absence was found by mutation rather than by review:
     * one was written, and deleting it changed no test, because `claim` answers `closed` itself. Restating a
     * refusal the function already gives is a second place for the answer to come from — and it costs
     * nothing to remove, since the state was already in hand from the query above. `closeCase` below *does*
     * read it, and for a real reason: `close` reports a bare `changes = 0` with no way to tell "already
     * closed" from "somebody else holds it".
     */
    const outcome = await claim(env, ctx, butler.orgId, assignee, caseId);
    switch (outcome.kind) {
      case "claimed":
        return { outcome: "ok", reason: null, subject: caseId };
      case "closed":
        return refused("case_closed", caseId);
      case "held":
        return refused("case_held", caseId);
      default:
        // `claim` answers `not_found` for a case that does not exist **and** for one whose mailbox the
        // *assignee* may not send as. The check above already proved this case exists and is visible to the
        // Butler, so the remaining reading is the second one — which is a genuinely different answer from
        // the Butler's own lack of authority, and a person reading the run needs to be told which.
        return refused("assignee_may_not_work_it", caseId);
    }
  });
}

/**
 * `case.close`: `close`, which requires the closer to be **holding** the case.
 *
 * So a Butler can only close a case assigned to itself, and the shipped way to reach that is a `case.assign`
 * whose `assignee` is `"${butler.id}"`. That is stated plainly rather than worked around: widening `close`
 * to accept somebody who merely holds `send.propose` would change what closing means for people too, and the
 * one thing this engine must not do is give a program a path a human does not have.
 */
export async function closeCase(
  env: Env,
  ctx: Ctx,
  butler: ButlerPrincipal,
  node: Extract<ButlerNode, { type: "case.close" }>,
  state: RunState,
): Promise<EffectResult> {
  const caseId = text(evaluate(node.caseId, state, node.id));
  if (caseId === null) throw notAnId(node.id, "case", caseId);

  return await refusable(async () => {
    const target = await caseMailboxHeldBy(env, butler, caseId, "send.propose");
    if (target === null) return refused("case_not_actionable", caseId);
    if (target.state === "closed") return refused("case_closed", caseId);
    // Read from the row already in hand rather than from `close`'s bare `changes = 0`, so the refusal says
    // *which* of the two things was wrong — the same read-back `cancelSend` established and `claim` follows.
    if (target.assignee !== butler.butlerId) return refused("case_not_held_by_butler", caseId);

    const outcome = await close(env, ctx, butler.orgId, butler.butlerId, caseId);
    return outcome.closed
      ? { outcome: "ok", reason: null, subject: caseId }
      // Lost a race between the read and the update: somebody released, stole or closed it in between.
      : refused("case_held", caseId);
  });
}

/**
 * `draft`: `saveDraft`, authored by the Butler, **addressed by the Node** (#52).
 *
 * The node has no recipient parameter — §16 forbids untrusted content selecting To/CC/BCC, and an `Expr`
 * reads `event.*`, which is the inbound message. So the recipients come from `parentDelivery`, which reads
 * the envelope sender of the delivery that triggered this run, and a delivery with no return path faults
 * rather than defaulting. `src/butler/parent.ts` carries the choice of the envelope over the `From:` and
 * `Reply-To:` headers, and says what it does and does not buy.
 *
 * Derived **before** `refusable`, deliberately: this is a fault about the run's own inputs, in the same
 * family as an unresolvable path, and turning it into a governed refusal would make "there is nobody to
 * reply to" indistinguishable from "a policy said no".
 *
 * No `cc` and no `bcc` are passed at all, rather than empty arrays — a Butler cannot copy anybody, and an
 * absent argument is one fewer place for that to change quietly.
 */
export async function writeDraft(
  env: Env,
  ctx: Ctx,
  butler: ButlerPrincipal,
  node: Extract<ButlerNode, { type: "draft" }>,
  state: RunState,
  trigger: RunTrigger,
): Promise<EffectResult> {
  const mailboxId = text(evaluate(node.mailboxId, state, node.id));
  if (mailboxId === null) throw notAnId(node.id, "mailbox", mailboxId);
  const to = replyRecipients(parentDelivery(trigger, node.id));
  const subject = String(evaluate(node.subject, state, node.id));
  const body = String(evaluate(node.body, state, node.id));
  const inReplyTo = node.inReplyTo === undefined
    ? null
    : text(evaluate(node.inReplyTo, state, node.id));

  return await refusable(async () => {
    // `null` for the draft id, always: a Butler writes a new draft rather than editing one. An upsert would
    // let a run overwrite a draft a person is typing into, and `saveDraft`'s own author filter is what makes
    // that impossible — but only because the author is the Butler, which is a property of this call rather
    // than of that function.
    const record = await saveDraft(env, ctx, butler.orgId, butler.butlerId, null, {
      mailboxId, to, subject, body, inReplyToMessageId: inReplyTo,
    });
    return {
      outcome: "ok",
      reason: null,
      subject: record.id,
      /*
       * Bound without the body. `mail.send.propose` reads the draft back out of storage rather than out of
       * this binding, so carrying the text here would buy nothing and would put an author-controlled string
       * of up to a D1 row's worth of bytes into a `step.do` return value — which is the 1 MiB ceiling #50
       * says goes to R2 by reference. The projection is the same shape a `lookup` of a draft returns, so an
       * author reads one field list rather than two.
       */
      bind: {
        id: record.id,
        mailboxId: record.mailboxId,
        subject: record.subject,
        to: record.to,
        inReplyToMessageId: record.inReplyToMessageId,
        bodyBytes: record.bodyBytes,
      },
    };
  });
}

/**
 * `mail.send.propose`: `sealManifest`, with `releaseRequired` set.
 *
 * The one external effect in the shipped set, and therefore the layer's whole proof line. Three things
 * happen here and each is a decision:
 *
 * 1. **The draft is read back out of storage** rather than taken from the previous step's binding, through
 *    the same `readDraft` a person's send path would use. It re-checks the Butler's `send.propose` — which
 *    `sealManifest` will check again a moment later, so it is two reads of one relation and it is measured
 *    and reported in `docs/receipts/butler-run-cost.md` rather than optimised away. §7 wants authority
 *    re-read per operation, and a second read path for drafts would be a second thing to keep in step with
 *    the first.
 * 2. **`releaseRequired: true`, unconditionally.** A program does not get to decide that a person agreed.
 * 3. **The sealed state is read back and recorded, not interpreted.** A gated seal is an effect that
 *    happened and mail that has not left, so the outcome is `ok` and the reason is the manifest's own state
 *    token. A `withheld` seal is a refusal. The engine adds no vocabulary of its own here: every token comes
 *    off the manifest, which is what keeps the run record and the outbox saying the same thing.
 */
export async function proposeSend(
  env: Env,
  ctx: Ctx,
  butler: ButlerPrincipal,
  node: Extract<ButlerNode, { type: "mail.send.propose" }>,
  state: RunState,
): Promise<EffectResult> {
  const resolved = evaluate(node.draft, state, node.id);
  // Accepts the binding a `draft` node produced as well as a bare id, because `"${steps.reply}"` is what an
  // author writes and `"${steps.reply.id}"` is what they mean. One field, one meaning, two spellings.
  const draftId = text(resolved)
    ?? (resolved !== null && typeof resolved === "object"
      ? text((resolved as Record<string, unknown>).id)
      : null);
  if (draftId === null) throw notAnId(node.id, "draft", resolved);

  return await refusable(async () => {
    const draft = await readDraft(env, butler.orgId, butler.butlerId, draftId);
    if (draft === null) {
      // Absent, or somebody else's. A Butler may only send its own drafts, and §5C keeps the two answers
      // alike so a Butler cannot be used to discover which draft ids exist.
      return refused("not_readable", draftId);
    }

    const sealed = await sealManifest(env, ctx, butler.orgId, {
      mailboxId: draft.mailboxId,
      authorUserId: butler.butlerId,
      inReplyToMessageId: draft.inReplyToMessageId ?? undefined,
      to: draft.to,
      cc: draft.cc.length === 0 ? undefined : draft.cc,
      bcc: draft.bcc.length === 0 ? undefined : draft.bcc,
      subject: draft.subject,
      bodyTyped: draft.body,
      // ADR 33: the bytes are what the program authored, not a reconstruction of something else.
      fidelity: "authored",
      releaseRequired: true,
    });

    if (sealed.state === "withheld") {
      /*
       * A `withheld` seal always carries a reason — `policy_denied`, `approval_unsatisfiable` or
       * `domain_paused` — so this is a refusal with the manifest's own token, and the engine invents no
       * vocabulary of its own here. A `withheld` with a **null** reason would be a contradiction inside
       * `sealManifest` rather than a governed refusal, so it is recorded as a **fault** with an `E_` code
       * instead of a refusal token nothing in the outbox could explain. That branch is unreachable today
       * and is written this way so that if it ever fires, the run says "something is wrong" rather than
       * "somebody decided".
       */
      return sealed.stateReason === null
        ? { outcome: "failed", reason: "E_SEAL_WITHHELD_WITHOUT_REASON", subject: sealed.id }
        : refused(sealed.stateReason, sealed.id);
    }
    return {
      outcome: "ok",
      reason: sealed.stateReason,
      subject: sealed.id,
      bind: { id: sealed.id, state: sealed.state, stateReason: sealed.stateReason },
      // Parked only on this Node's own gate. When a *policy* gated the send, the human it needs is an
      // approver and the approval machinery is what asks them — parking as well would be a second ask for
      // one send. When a rate breaker gated it, nothing has to be cleared by anybody.
      ...(sealed.stateReason === BUTLER_RELEASE_REASON ? { park: BUTLER_RELEASE_REASON } : {}),
    };
  });
}

/** `lookup`: one bounded row read, projected. Not an effect — recorded because it can be refused. */
export async function lookupRow(
  env: Env,
  butler: ButlerPrincipal,
  node: Extract<ButlerNode, { type: "lookup" }>,
  state: RunState,
): Promise<EffectResult> {
  const entityId = text(evaluate(node.entityId, state, node.id));
  if (entityId === null) throw notAnId(node.id, node.entity, entityId);

  const row = await readEntity(env, butler, node.entity, entityId);
  return row === null
    ? refused("not_readable", entityId)
    : { outcome: "ok", reason: null, subject: entityId, bind: row };
}
