import { BUDGETS } from "@mailda/budgets";
import { butler as butlerSchema, type Butler } from "@mailda/butler-ast";
import type { Ctx } from "@mailda/runtime";

import { log } from "../audit.ts";
import type { ButlerRunPayload } from "./interpret.ts";
import {
  describeLoopTrip, loopReading, loopWindowStart, pausedFrom, PAUSE_AND_LOOP_COLUMNS,
  type PauseAndLoopRow,
} from "./pause.ts";
import { placeButlerPause } from "./pause-acts.ts";

/**
 * What starts a run: one delivery, every published Butler listening on the mailbox it landed in (#50).
 *
 * ## The instance id is the whole idempotency mechanism
 *
 * `<butlerVersionId>-<triggerKey>`, where the trigger key is the `msg_` id of the delivery. `create({ id })`
 * **throws `instance.already_exists`** on a duplicate within the instance's retention window, so the same
 * delivery cannot start two runs of the same version — and the refusal comes from the platform rather than
 * from a check written here. That is conflict-is-the-signal, the pattern already carrying the audit
 * sequence, the migration ledger, `send_recipient_events` and the claim CAS. §16's `forbid` overlap policy
 * is therefore free.
 *
 * It matters because this function is called from an **at-least-once** pipeline: `materialiseReceipt` is
 * driven by an outbox event, and #9's model is explicit that a handler will see the same event twice and
 * must not care.
 *
 * Three things that must not be conflated, each stated because each is easy to get wrong:
 *
 * - **The run id is not an ADR 9 effect key.** It dedups the *trigger*. Every sending step still mints its
 *   own effect key — the manifest id — so one intent produces one run and many effects.
 * - **The dedup window is 30 days**, being the instance retention. After it the same id is creatable again.
 *   That is a property of the platform, not of this design, and `butler_runs`' primary key is what refuses
 *   the second *record* for ever.
 * - **`createBatch` is not used, and must not be.** It **silently skips** a duplicate id and excludes it
 *   from the returned array — measured at 4 requested, 1 returned, no error. A fan-out built on it drops
 *   runs with nothing to notice. `create` per item is what makes a duplicate throw.
 *
 * ## What is measured locally and what is not, said rather than assumed
 *
 * The throw was measured against the real platform (`workflow-provisioning.md`). **Miniflare's local
 * Workflows emulation does not reproduce it**: its `create` resolves and swallows the initialisation
 * failure, so a duplicate returns a handle and starts no second run. So locally the *outcome* holds — one
 * run per delivery — while the *refusal* is invisible. This function therefore counts a resolved `create` as
 * started and a thrown `already_exists` as a duplicate, and `test/butler-run.test.ts` proves both arms: the
 * outcome against real storage, and the handling against a binding that throws.
 *
 * ## Matching is a JSON parse per published Butler, and that is a deliberate cost
 *
 * A trigger lives inside `ast_json`, which is a blob (0027 argues why), so no index can answer *"which
 * Butlers listen on this address"*. This reads every published version for the organization — one query on
 * `btv_live`, which is partial on `state = 'published'` — and parses each. The alternative is a projected
 * trigger column, which is a second copy of a fact inside the frozen AST and therefore a thing that can
 * disagree with the program. At the scale a Node publishes Butlers that trade is obviously right; the day it
 * is not, the fix is an index built *from* the AST at publication, not a column an author can set.
 *
 * ## This runs in the sweeper's invocation, not in the run's
 *
 * Its cost is charged to whatever invoked `materialiseReceipt`, not to any Butler's pot.
 * `docs/receipts/butler-run-cost.md` measures it separately for that reason.
 *
 * ## This is where a pause is evaluated, and where one is placed (#75)
 *
 * #66 decided that a Butler stopped by a breaker is a latched row keyed on `butler_id`, **evaluated at
 * trigger time**. This function is that place. A paused Butler does not start a run at all — an abuse breaker
 * refuses rather than gating — so what a paused Butler looks like is **silence**, which is why `doctor` grew
 * `butler_paused` and `butler_run_silence` in the same change.
 *
 * The pause and the loop reading are **five correlated sub-selects on the version listing this function was
 * already issuing**, so asking costs nothing: `butler.pause_check_added_subrequests` is 0, pinned as an
 * equality in `docs/receipts/butler-pause.md`. A paused Butler is in fact *cheaper* than a running one,
 * because the `create` never happens.
 *
 * Placing a pause costs one `auditedBatch`, once, at the moment the reading goes over — never per delivery.
 * `src/butler/pause-acts.ts` carries who may place one (nothing but this) and who may resume one (one
 * administrator, with a mandatory reason).
 */

/**
 * The facts a `mail.received` run reads as `event.*`. Closed, so an author can be told what is there.
 *
 * A `type` rather than an `interface`, and that is load-bearing rather than a style choice: TypeScript infers
 * an implicit index signature for an object *type alias* and not for an interface, so only this form is
 * assignable to the payload's `Readonly<Record<string, unknown>>` without a cast. A cast there would be the
 * one place in this file where the compiler stopped checking that the run's `event` root is exactly these
 * fields.
 */
export type DeliveryFacts = {
  readonly message_id: string;
  readonly conversation_id: string | null;
  readonly case_id: string | null;
  readonly mailbox_id: string;
  readonly mailbox_address: string;
  readonly subject: string;
  /**
   * The `From:` header, as the sender wrote it. **Content**, and readable for that reason only.
   *
   * A guard may match on it — *"is this from a supplier"* — and nothing addresses mail with it. What a reply
   * goes to is `return_path` below, and the distinction is #52's whole subject: a header is chosen by
   * whoever sent the message.
   */
  readonly from: string;
  /**
   * The envelope sender of this delivery — RFC 5321's reverse path, `ingress_receipts.envelope_from`.
   *
   * **This is what a Butler's reply is addressed to** (`src/butler/parent.ts`), which is why it is a fact of
   * the delivery rather than a parameter of a node. Empty when the message arrived with a null reverse path
   * (`MAIL FROM:<>`) — a bounce — and a `draft` in that run refuses rather than guessing. An author who
   * expects such deliveries guards on this before drafting.
   *
   * Not called `reply_to`: the `Reply-To:` header is a different thing, it is content, and honouring it
   * would be the sink under another name. The name says which of the two this is.
   */
  readonly return_path: string;
  readonly received_at: string;
  /** Non-null when the message's headers could not be read. §24 keeps such a message, visibly unparsed. */
  readonly parse_error: string | null;
};

/**
 * Which of the facts above are **the sender's words**, and which are this Node's own (#53, #63).
 *
 * The fact set is the `event.*` root a run was given, and `butler_runs.trigger_facts` freezes it. That makes it
 * readable long after the delivery, by anybody who can read a run — so somebody has to say, once, which of
 * these fields is mail content. This is that statement, and it lives here rather than at the reading end
 * because the field and its classification must move together: `from` is already documented above as
 * *"Content, and readable for that reason only"*, and a classification written somewhere else is a second
 * place for that sentence to be true.
 *
 * A **total map** over `DeliveryFacts`, so a tenth fact does not compile until somebody classifies it. That is
 * the whole shape: a list of fields to hide would guard only the spellings its author thought of, and the fact
 * set is the thing that grows — #52 grew it by `return_path` and four hand-written copies of it went stale the
 * same day. `redactFacts` below therefore treats an **unknown** key as content too, because the map constrains
 * what can be written here and cannot constrain what a stored JSON blob holds.
 *
 * Two entries are worth the argument:
 *
 *   - **`return_path` is content**, even though this Node read it off the envelope rather than off a header.
 *     It is an address a stranger chose and it is who a reply goes to; disclosing it discloses who wrote in.
 *   - **`parse_error` is content**, which is stricter than it looks. Two of its three spellings are this
 *     Node's own sentences (`E_NO_MESSAGE_ID`, `E_NO_DATE`), but the third is
 *     `E_HEADERS_UNPARSED  <the parser's message>` — a string interpolated from the failure to read the
 *     sender's bytes, which can quote them. One spelling that can carry content makes the field content, and
 *     the alternative is a classification that is right twice and wrong once with nothing to say which.
 *
 * `mailbox_address` is **operational**: it is the organization's own address, the one the run's Butler is
 * declared against, and it names nobody outside. `received_at` is what this Node observed.
 *
 * ## `"content"` here is a narrower word than `mailbox.content.read`'s, and the bound is worth stating
 *
 * Everything a fact set can carry is **header-grade**: a subject, two addresses and a parser's complaint.
 * That is why `inspectRun` gates it on `mayReadMetadata` — whose own contract is *"subject lines, sender
 * addresses"* — rather than on the body relation, and it is only sound while the sentence above stays true of
 * every member. A fact carrying **body** bytes would be content this classification cannot describe: it would
 * read `"content"` and open to a `mailbox.metadata.read` holder, who by definition may not read a body.
 *
 * Nothing has to be remembered for that to be caught. `deliveryFacts` below is the sole producer, the map is
 * total over its type so a new field does not compile unclassified, and `test/butler-replay.test.ts` pins
 * these ten keys by name — so a body-grade fact cannot arrive without a person editing all three and being
 * asked which authority it takes.
 */
export const FACT_DISCLOSURE: { [K in keyof DeliveryFacts]: "content" | "operational" } = {
  message_id: "operational",
  conversation_id: "operational",
  case_id: "operational",
  mailbox_id: "operational",
  mailbox_address: "operational",
  received_at: "operational",
  subject: "content",
  from: "content",
  return_path: "content",
  parse_error: "content",
};

/**
 * A fact set with the content removed, and **the list of what was removed beside it**.
 *
 * The list is the point. A redacted `subject` reads as `null`, and so does a message that genuinely had none
 * (`deliveryFacts` writes the empty string, but a pre-0030 or future fact set may not) — while a redacted
 * `parse_error` reading `null` would say the headers parsed cleanly, which is a *false* answer rather than an
 * absent one. Naming the keys turns every one of those nulls back into "withheld from you", so the caller is
 * told there is a hole rather than handed a hole shaped like an answer.
 *
 * Pure, and the authority is somebody else's decision: `inspectRun` decides *whether* to call this.
 */
export function redactFacts(
  facts: Readonly<Record<string, unknown>>,
): { facts: Record<string, unknown>; redacted: string[] } {
  const kept: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(facts)) {
    const classification = Object.hasOwn(FACT_DISCLOSURE, key)
      ? FACT_DISCLOSURE[key as keyof DeliveryFacts]
      : "content";
    if (classification === "operational") {
      kept[key] = value;
    } else {
      kept[key] = null;
      redacted.push(key);
    }
  }
  return { facts: kept, redacted };
}

export interface TriggerOutcome {
  /** Instance ids created by this call. */
  readonly started: readonly string[];
  /** Instance ids the platform refused because a run for this delivery already exists. */
  readonly duplicates: readonly string[];
  /** Published Butlers whose trigger names a different mailbox. */
  readonly notListening: number;
  /**
   * Published versions this call started nothing for, and **not** because of their trigger.
   *
   * Two causes, and the field is named for what it means to a caller rather than for either of them: the
   * stored AST would not parse as a Butler at all, or the run's id would not fit
   * `workflow.instance_id_max_chars`. It was called `unreadable` first, which was a name overclaiming a
   * cause — an over-long id is a perfectly readable program — and a caller cannot act differently on the two
   * anyway, since both mean *this Butler did not run and the log says why*. The log entry is what
   * distinguishes them, and it names the version in both cases.
   */
  readonly notStarted: readonly string[];
  /**
   * Butlers that matched this delivery and were **passed over because a pause is in force** (#75).
   *
   * `btl_` ids rather than instance ids, because there is no instance: a paused Butler starts no run, so
   * there is nothing with a run's identity to name. Reported rather than logged, and that is a decision: a
   * pass-over happens once per delivery per paused Butler, which is the per-row frequency
   * `audit-and-log-retention.md`'s sizing forbids in the trail and would drown `log_entries`. What records it
   * is the latched row itself, and `doctor`'s `butler_paused` finding is what puts it in front of a person.
   */
  readonly paused: readonly string[];
  /**
   * Butlers this call **paused**, having found their self-provoked run count over the limit.
   *
   * At most one entry per Butler ever, because the pause latches. A `btl_` id appears here on the delivery
   * that tripped it and in `paused` on every delivery after it.
   */
  readonly looped: readonly string[];
}

interface VersionRow extends PauseAndLoopRow {
  id: string;
  butler_id: string;
  butler_name: string;
  ast_json: string;
}

/** Whether a `create` failure is the platform refusing a duplicate rather than a fault. */
function isDuplicate(error: unknown): boolean {
  // Matched on the documented error name rather than on a code, because the platform reports it as
  // `instance.already_exists` and a numeric code for it is not published. Narrow on purpose: anything else
  // is a real failure and must not be counted as "already running".
  return /instance\.already_exists|already exists/i.test((error as Error)?.message ?? "");
}

/**
 * The facts of one delivery, or null when it is not one this Node can attribute.
 *
 * One query. The mailbox comes through `ingress_receipts.envelope_to` → `addresses`, which is the only thing
 * that says where a message actually landed — `messages` carries no mailbox column, and organization
 * membership is a different question. The case is joined on `(conversation, mailbox)` because that is the key
 * `caseForDelivery` files it under.
 *
 * **Exported for the tests, and that is a fix rather than a convenience.** Four test files each carried a
 * hand-written copy of this statement, one of them under the comment *"the same facts `trigger.ts` assembles,
 * read the same way, so a test cannot drift from production"* — a claim a copy cannot enforce, and #52 caught
 * all four of them missing `return_path` the moment the fact set grew. Since a Butler's recipients are now
 * derived from these facts, a test fixture that disagreed with production would be a test of a delivery this
 * Node never produces.
 */
export async function deliveryFacts(
  env: Env,
  orgId: string,
  messageId: string,
): Promise<DeliveryFacts | null> {
  const row = await env.CATALOG.prepare(
    `SELECT m.id AS message_id, m.conversation_id, m.subject, m.from_addr, m.received_at, m.parse_error,
            r.envelope_from, a.mailbox_id, a.address AS mailbox_address, k.id AS case_id
       FROM messages m
       JOIN ingress_receipts r ON r.org_id = m.org_id AND r.id = m.ingress_receipt_id
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN cases k ON k.org_id = m.org_id AND k.conversation_id = m.conversation_id
                        AND k.mailbox_id = a.mailbox_id
      WHERE m.org_id = ? AND m.id = ? LIMIT 1`,
  ).bind(orgId, messageId).first<{
    message_id: string; conversation_id: string | null; subject: string | null; from_addr: string | null;
    envelope_from: string | null; received_at: string; parse_error: string | null; mailbox_id: string;
    mailbox_address: string; case_id: string | null;
  }>();
  if (row === null) return null;
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    case_id: row.case_id,
    mailbox_id: row.mailbox_id,
    mailbox_address: row.mailbox_address,
    // Empty rather than null: `event.subject` is a string an expression interpolates, and a message with an
    // unreadable or absent Subject genuinely has none. `parse_error` is what says which of the two it was.
    subject: row.subject ?? "",
    from: row.from_addr ?? "",
    // `envelope_from` is NOT NULL in `ingress_receipts`, so the coalesce is not a defended NULL: it is the
    // null reverse path, which providers hand over as an empty string. Kept as the empty string rather than
    // rewritten to something friendlier, because `parent.ts` reads exactly this to decide that there is
    // nobody to reply to.
    return_path: row.envelope_from ?? "",
    received_at: row.received_at,
    parse_error: row.parse_error,
  };
}

/**
 * Starts a run of every published Butler listening on the mailbox this message landed in.
 *
 * Never throws for a reason that belongs to one Butler: a version whose stored AST will not parse is
 * counted, logged and skipped, so one bad row cannot stop every other Butler on the Node from firing. A
 * failure to reach D1 or the workflow binding *does* propagate, because the caller is an outbox handler and
 * leaving the event unpublished is what makes the retry happen (#9, ADR 31).
 */
export async function triggerButlers(
  env: Env,
  ctx: Ctx,
  orgId: string,
  messageId: string,
): Promise<TriggerOutcome> {
  const facts = await deliveryFacts(env, orgId, messageId);
  if (facts === null) {
    // A message with no attributable mailbox: its address was removed, or the receipt is gone. Nothing to
    // trigger, and not an error — the same judgement `materialiseReceipt` makes about a receipt that has
    // disappeared, for the same reason: raising would wedge the outbox on an event that can never succeed.
    return { started: [], duplicates: [], notListening: 0, notStarted: [], paused: [], looped: [] };
  }

  /*
   * One statement for three questions: which Butlers are published, which of them is paused, and how long a
   * chain each has made itself. The pause and loop columns are correlated sub-selects on `v`, so this costs
   * exactly what it cost before #75 — measured, `docs/receipts/butler-pause.md`.
   *
   * `butlers` is joined for the **name**, which the pause's stored sentence needs: *"Butler btl_01J… has been
   * re-triggered four times"* answers nothing, and `createButlerDraft` refuses a nameless Butler for exactly
   * that reason.
   *
   * `?1`, `?2`, `?3` are numbered rather than anonymous because `PAUSE_AND_LOOP_COLUMNS` is pasted in from
   * another module and names its own positions. An unnumbered `?` there would take whatever slot this
   * statement happened to leave it.
   */
  const { results } = await env.CATALOG.prepare(
    `SELECT v.id, v.butler_id, v.ast_json, b.name AS butler_name,
      ${PAUSE_AND_LOOP_COLUMNS}
     FROM butler_versions v JOIN butlers b ON b.org_id = v.org_id AND b.id = v.butler_id
     WHERE v.org_id = ?1 AND v.state = 'published'`,
  ).bind(orgId, facts.message_id, loopWindowStart(ctx.now())).all<VersionRow>();

  const started: string[] = [];
  const duplicates: string[] = [];
  const notStarted: string[] = [];
  const paused: string[] = [];
  const looped: string[] = [];
  let notListening = 0;
  const wanted = facts.mailbox_address.trim().toLowerCase();

  for (const version of results) {
    let ast: Butler;
    try {
      // The envelope only, through the AST's own schema. Not `checkButler`: matching a trigger needs the
      // trigger, and a version whose *graph* has become uncheckable — a node moved from shipped to reserved
      // since it was published — must still be able to start a run, because the run is where that refusal
      // belongs and where it becomes visible to a person. `interpret` re-checks and refuses it there.
      ast = butlerSchema.parse(JSON.parse(version.ast_json));
    } catch {
      notStarted.push(version.id);
      continue;
    }

    if (ast.trigger.event !== "mail.received") {
      // Unreachable while `mail.received` is the only member of the trigger enum, and written rather than
      // asserted because the enum is what #49 says will grow: the day a second trigger exists, a Butler
      // listening for it must not fire on a delivery.
      notListening += 1;
      continue;
    }
    if (ast.trigger.mailbox.trim().toLowerCase() !== wanted) {
      notListening += 1;
      continue;
    }

    /*
     * The pause, evaluated **after** the trigger match and before anything else (#75).
     *
     * After, because a Butler listening on another mailbox was never going to run and calling it "paused"
     * would put it in a list an operator reads as *"these were stopped"*. Before everything else, because a
     * pause is an abuse breaker: it refuses rather than gating, so the answer is that no run happens — not a
     * run that starts and refuses itself, and not a queue somebody releases later.
     *
     * The row was read in the statement above at no extra cost, so this is a comparison rather than a query.
     */
    const inForce = pausedFrom(version);
    if (inForce !== null) {
      paused.push(version.butler_id);
      continue;
    }

    /*
     * The loop detector, and it is the thing that places a pause.
     *
     * `loop_prior` and `loop_this` came back with the row: how many runs of this Butler inside the window
     * were triggered by a reply to a send **this Butler** made, and whether the delivery in front of us is
     * one too. `docs/receipts/butler-pause.md` says what that count can and cannot see, and says plainly
     * that a Butler-proposed send cannot leave this Node today without a person releasing it — so what this
     * catches now is a human-assisted chain, and what it exists for is the day that gate moves.
     *
     * The pause is placed **before** the run it refuses would have started, so the trip and the refusal are
     * one decision rather than a run that has to be caught later.
     */
    const loop = loopReading(version);
    if (loop.tripped) {
      const placed = await placeButlerPause(env, ctx, orgId, {
        butlerId: version.butler_id,
        butlerName: version.butler_name,
        reason: "loop_detected",
        detail: describeLoopTrip(loop, { id: version.butler_id, name: version.butler_name }, facts.message_id),
        trippedBy: facts.message_id,
      });
      // `null` means a concurrent delivery placed it first, which is the outcome this wanted: the Butler is
      // paused either way. Reported as `paused` rather than `looped`, because this call did not place it.
      if (placed === null) paused.push(version.butler_id);
      else looped.push(version.butler_id);
      continue;
    }

    /*
     * The id, and the one bound worth checking: `workflow.instance_id_max_chars = 100` is documented, and a
     * typed-prefix ULID pair comes to 61 — so this is a tripwire past where any real id goes, and only a
     * changed id scheme reaches it. Refusing here rather than letting `create` reject it means the Butler is
     * named in the log instead of the failure arriving as an opaque platform error.
     */
    const instanceId = `${version.id}-${facts.message_id}`;
    if (instanceId.length > BUDGETS["workflow.instance_id_max_chars"]) {
      await log(env, ctx, {
        level: "error",
        event: "butler.instance_id_too_long",
        message: `E_BUDGET_EXCEEDED  workflow.instance_id_max_chars=`
          + `${BUDGETS["workflow.instance_id_max_chars"]}, this run's id would be ${instanceId.length}`,
        orgId,
        detail: { versionId: version.id, messageId: facts.message_id },
      }).catch(() => undefined);
      notStarted.push(version.id);
      continue;
    }

    const payload: ButlerRunPayload = {
      orgId,
      butlerId: version.butler_id,
      butlerVersionId: version.id,
      trigger: { event: ast.trigger.event, key: facts.message_id, facts },
    };

    try {
      // `create`, one per Butler, never `createBatch` — see the header.
      await env.BUTLER_RUNS.create({ id: instanceId, params: payload });
      started.push(instanceId);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      duplicates.push(instanceId);
    }
  }

  return { started, duplicates, notListening, notStarted, paused, looped };
}
